import argparse
import io
import logging
import os
import platform
import sys
import time
from datetime import UTC, datetime, timedelta
from logging.handlers import RotatingFileHandler

from pydub import AudioSegment

import settings
from discovery import Importer, extract_device_info
from lib.api import exchange_api_key_for_jwt, job_token_var
from lib.resources import call_resource

#%%

logger = logging.getLogger('daemon')

log_dir = os.path.expanduser('~/Library/mycelia/logs')
os.makedirs(log_dir, exist_ok=True)
log_file = os.path.join(log_dir, 'daemon.log')

console = logging.StreamHandler()
console.setLevel(logging.INFO if sys.stderr.isatty() else logging.WARNING)

file_handler = RotatingFileHandler(
    log_file,
    maxBytes=10 * 1024 * 1024,
    backupCount=3,
)
file_handler.setLevel(logging.DEBUG)

formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
console.setFormatter(formatter)
file_handler.setFormatter(formatter)

logging.basicConfig(level=logging.DEBUG, handlers=[console, file_handler])

logger.info(f"Logging to {log_file}")


def initialize_auth() -> str:
    """Exchange the configured API credentials for a daemon JWT."""
    jwt_token = exchange_api_key_for_jwt()
    job_token_var.set(jwt_token)
    return jwt_token


_importer_error_state: dict[str, tuple[str, float]] = {}


def import_new_files() -> list[dict]:
    results = []
    for importer in settings.importers:
        try:
            discovered = importer.run()
            warning = getattr(importer, "last_warning", None)
            if importer.code in _importer_error_state:
                logger.info("Importer %s recovered", importer.code)
                _importer_error_state.pop(importer.code, None)
            results.append({
                "source": importer.code,
                "status": "degraded" if warning else "completed",
                "discovered": discovered,
                **({"warning": warning} if warning else {}),
            })
        except Exception as e:
            message = str(e)
            now = time.monotonic()
            previous = _importer_error_state.get(importer.code)
            if previous is None or previous[0] != message or now - previous[1] >= 300:
                logger.exception('Error importing files via %s', importer.code)
                _importer_error_state[importer.code] = (message, now)
            results.append({
                "source": importer.code,
                "status": "failed",
                "error": message,
            })
    return results


importer_map = {importer.code: importer for importer in settings.importers}
unknown_importer = Importer(code="unknown")


def ingests_missing_sources(
    limit=None,
    retry_errors=False,
    only_errors=False,
    source_ids=None,
    source_path_overrides=None,
) -> dict[str, int]:
    """Ingest a bounded selection and report failures, including cached ones."""
    source_ids = list(source_ids or [])
    source_path_overrides = {
        str(source_id): path
        for source_id, path in (source_path_overrides or {}).items()
    }
    scope_query = {}
    if source_ids:
        # An explicit operator-selected ID is authoritative, including legacy
        # records whose importer code or host name predates current settings.
        scope_query["_id"] = {"$in": source_ids}
    else:
        scope_query["$or"] = [
            {
                "path": {"$exists": True},
                "platform.node": platform.node(),
            },
            {"platform.importer": {"$in": list(importer_map.keys())}},
        ]

    base_query = {"ingested": False, **scope_query}
    if only_errors:
        base_query["ingestion.error"] = {"$exists": True}
    elif not retry_errors:
        base_query["ingestion.error"] = {"$exists": False}

    total_pending = call_resource('mongo', {
        "action": "count",
        "collection": "source_files",
        "query": base_query
    })

    already_ingested = call_resource('mongo', {
        "action": "count",
        "collection": "source_files",
        "query": {"ingested": True, **scope_query}
    })

    errored_count = call_resource('mongo', {
        "action": "count",
        "collection": "source_files",
        "query": {
            "ingested": False,
            "ingestion.error": {"$exists": True},
            **scope_query,
        }
    })

    # retry_errors includes cached failures in total_pending; do not count the
    # same selected source twice in progress totals.
    cached_excluded_errors = 0 if retry_errors or only_errors else errored_count
    total_files = already_ingested + total_pending + cached_excluded_errors
    result = {
        "attempted": 0,
        "succeeded": 0,
        "failed": 0,
        "remaining": total_pending,
        "cached_errors": errored_count,
    }

    if total_pending == 0:
        if errored_count > 0:
            logger.info(f"Ingestion idle: {already_ingested}/{total_files} files successfully ingested, {errored_count} errored files cached")
        else:
            logger.info(f"✓ Ingestion complete: {already_ingested}/{total_files} files successfully ingested")
        return result

    logger.info(f"Starting ingestion: {total_pending} pending, {already_ingested} already ingested, {errored_count} errored (Total: {total_files} files)")

    query = call_resource('mongo', {
        "action": "find",
        "collection": "source_files",
        "query": base_query,
        "options": {
            "sort": {"start": -1, "_id": 1},
            **({"limit": limit} if limit is not None else {}),
        },
    })

    processed = 0
    errors = 0

    for idx, source in enumerate(query, 1):
        replacement_path = source_path_overrides.get(str(source['_id']))
        source_for_upload = (
            {**source, "path": replacement_path}
            if replacement_path
            else source
        )
        file_path = source_for_upload.get('path', str(source['_id']))
        file_name = os.path.basename(file_path) if 'path' in source else str(source['_id'])

        logger.info(f"Processing [{idx}/{min(limit or total_pending, total_pending)}]: {file_name}")

        try:
            importer = importer_map.get(
                source['platform'].get('importer'),
                unknown_importer
            )
            importer.upload(source_for_upload)
            call_resource('mongo', {
                "action": "updateOne",
                "collection": "source_files",
                "query": {"_id": source["_id"]},
                "update": {
                    "$set": {
                        "ingested": True,
                        "ingested_at": datetime.now(tz=UTC),
                    },
                    # A successful retry supersedes the cached failure. Keeping
                    # it makes the pipeline UI label an ingested source as an
                    # error forever.
                    "$unset": {"ingestion": ""},
                }
            })
            processed += 1
            if "error" in source.get("ingestion", {}):
                result["cached_errors"] -= 1
            logger.info(f"✓ Successfully ingested: {file_name}")
        except Exception as e:  # noqa: BLE001 - cache failures per audio file
            errors += 1
            if "error" not in source.get("ingestion", {}):
                result["cached_errors"] += 1
            error_msg = str(e)
            logger.error(f"✗ Error ingesting {file_name}: {error_msg[:100]}")

            call_resource('mongo', {
                "action": "updateOne",
                "collection": "source_files",
                "query": {"_id": source["_id"]},
                "update": {"$set": {
                    "ingestion": {
                        "error": error_msg,
                        "last_attempt": datetime.now(tz=UTC),
                    }
                }}
            })

    remaining = total_pending - processed - errors
    new_ingested_total = already_ingested + processed
    new_errored_total = result["cached_errors"]
    logger.info(f"Batch complete: {processed} processed, {errors} errors, {remaining} remaining")
    logger.info(f"Overall status: {new_ingested_total}/{total_files} ingested, {new_errored_total} errored")
    result.update(
        attempted=processed + errors,
        succeeded=processed,
        failed=errors,
        remaining=remaining,
    )
    return result





def list_errored_files():
    errored_files = call_resource('mongo', {
        "action": "find",
        "collection": "source_files",
        "query": {
            "ingested": False,
            "ingestion.error": {"$exists": True}
        },
        "sort": [('ingestion.last_attempt', -1)]
    })

    count = 0
    for source in errored_files:
        count += 1
        file_path = source.get('path', str(source['_id']))
        file_name = os.path.basename(file_path) if 'path' in source else str(source['_id'])
        error = source['ingestion']['error'][:100]
        last_attempt = source['ingestion']['last_attempt'].strftime('%Y-%m-%d %H:%M:%S')
        print(f"{count}. {file_name}")
        print(f"   ID: {source['_id']}")
        print(f"   Error: {error}")
        print(f"   Last attempt: {last_attempt}")
        print()

    if count == 0:
        print("No errored files found")
    else:
        print(f"Total: {count} errored files")

    return count


def clear_error(file_id):
    result = call_resource('mongo', {
        "action": "updateOne",
        "collection": "source_files",
        "query": {"_id": file_id},
        "update": {"$unset": {"ingestion": ""}}
    })
    if result.modified_count > 0:
        logger.info(f"Cleared error for file {file_id}")
        return True
    else:
        logger.warning(f"File {file_id} not found or no error to clear")
        return False


def clear_all_errors():
    result = call_resource('mongo', {
        "action": "updateMany",
        "collection": "source_files",
        "query": {"ingestion.error": {"$exists": True}},
        "update": {"$unset": {"ingestion": ""}}
    })
    logger.info(f"Cleared errors for {result['modifiedCount']} files")
    return result['modifiedCount']


def add_missing_durations():
    query = {
        "duration": {"$exists": False}
    }

    cursor = call_resource('mongo', {
        "action": "find",
        "collection": "source_files",
        "query": query
    })
    for original in cursor:
        # Find the latest chunk for this original
        latest_chunk = call_resource('mongo', {
            "action": "findOne",
            "collection": "audio_chunks",
            "query": {"meta.original_id": original["_id"]},
            "sort": [("start", -1)],
            "limit": 1
        })
        if latest_chunk:
            end = latest_chunk["start"] + timedelta(seconds=AudioSegment.from_file(io.BytesIO(latest_chunk['data']), format="ogg").duration_seconds)
            duration = end - original["start"]
            call_resource('mongo', {
                "action": "updateOne",
                "collection": "source_files",
                "query": {"_id": original["_id"]},
                "update": {
                    "$set": {
                        "duration": duration.total_seconds()
                    }
                }
            })


def add_missing_ends():
    for original in call_resource('mongo', {
        "action": "find",
        "collection": "source_files",
        "query": {
            "duration": {"$exists": True},
            "end": {"$exists": False}
        }
    }):
        call_resource('mongo', {
            "action": "updateOne",
            "collection": "source_files",
            "query": {"_id": original["_id"]},
            "update": {
                "$set": {
                    "end": original["start"] + timedelta(seconds=original["duration"])
                }
            }
        })


def backfill_device_info(limit=100):
    """
    Backfill device info for source_files that don't have it yet.
    Only processes files from apple_voicememos importer that have local paths.
    """
    # Find records without device info that are from voice memos
    query = {
        "device": {"$exists": False},
        "platform.importer": "apple_voicememos",
        "path": {"$exists": True},
    }

    total_missing = call_resource('mongo', {
        "action": "count",
        "collection": "source_files",
        "query": query
    })

    if total_missing == 0:
        logger.info("✓ All voice memos have device info")
        return 0

    logger.info(f"Found {total_missing} voice memos without device info, processing up to {limit}...")

    records = call_resource('mongo', {
        "action": "find",
        "collection": "source_files",
        "query": query,
        "limit": limit,
    })

    updated = 0
    errors = 0

    for record in records:
        path = record.get('path')
        if not path or not os.path.exists(path):
            continue

        try:
            device_info = extract_device_info(path)
            if device_info:
                call_resource('mongo', {
                    "action": "updateOne",
                    "collection": "source_files",
                    "query": {"_id": record["_id"]},
                    "update": {"$set": {"device": device_info}}
                })
                updated += 1
                logger.debug(f"Added device info for {os.path.basename(path)}: {device_info.get('device_type')}")
        except Exception as e:  # noqa: BLE001 - continue device backfill
            errors += 1
            logger.warning(f"Error extracting device info for {path}: {e}")

    remaining = total_missing - updated
    logger.info(f"✓ Device info backfill: {updated} updated, {errors} errors, {remaining} remaining")
    return updated


#%%

def main(reset_errors=False):
    logger.info("=" * 60)
    logger.info("Starting daemon cycle")
    logger.info("=" * 60)

    total_steps = 5 if reset_errors else 4
    step = 1

    if reset_errors:
        logger.info(f"\n[{step}/{total_steps}] Resetting previous failed uploads...")
        cleared_count = clear_all_errors()
        logger.info(f"Cleared errors for {cleared_count} files")
        step += 1

    logger.info(f"\n[{step}/{total_steps}] Importing new files from sources...")
    import_new_files()
    step += 1

    logger.info(f"\n[{step}/{total_steps}] Ingesting audio files...")
    ingests_missing_sources(limit=20)
    step += 1

    logger.info(f"\n[{step}/{total_steps}] Backfilling device info...")
    backfill_device_info(limit=50)
    step += 1


    logger.info("=" * 60)
    logger.info("Daemon cycle complete")
    logger.info("=" * 60)


def run_vad_cycle(limit=1000, batch_size=100):
    """Run VAD directly, bypassing the backend job queue.

    The VAD module is imported lazily so the normal import daemon does not load
    Torch or the Silero model. Run this mode as a separate process alongside the
    normal daemon to analyze chunks while new audio is still being ingested.
    """
    from jobs.vad import VadJobData, process_vad_job

    job_id = f"daemon-vad-{os.getpid()}-{int(time.time())}"

    def report_progress(progress):
        logger.info(
            "VAD progress: processed=%s/%s, speech=%s",
            progress.get("processed", 0),
            progress.get("total", limit),
            progress.get("hasSpeech", 0),
        )

    return process_vad_job(
        job_id,
        VadJobData(limit=limit, batchSize=batch_size),
        report_progress,
    )


def run_cycles(cycle, *, once=False):
    """Run a daemon cycle once or continuously with the existing retry delay."""
    while True:
        start = time.time()
        try:
            cycle()
        except KeyboardInterrupt:
            raise
        except Exception:
            logger.exception("Error in main")
            if once:
                raise
            time.sleep(10)
            continue

        if once:
            return

        elapsed = time.time() - start
        if elapsed < 10:
            logger.info("Sleeping for a few seconds")
            time.sleep(10)


def build_parser():
    parser = argparse.ArgumentParser(description='Mycelia daemon for importing and processing audio files')
    parser.add_argument('--reset-errors', action='store_true',
                        help='Reset previous failed uploads on start by clearing error flags')
    parser.add_argument(
        '--vad-only',
        action='store_true',
        help='Only run VAD on chunks without VAD metadata; safe to run beside the normal import daemon',
    )
    parser.add_argument(
        '--vad-limit',
        type=int,
        default=1000,
        help='Maximum chunks processed per VAD cycle (default: 1000)',
    )
    parser.add_argument(
        '--vad-batch-size',
        type=int,
        default=100,
        help='Chunks fetched per VAD database batch (default: 100)',
    )
    parser.add_argument(
        '--once',
        action='store_true',
        help='Run one import or VAD cycle and exit instead of watching continuously',
    )
    return parser


def cli(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.vad_limit <= 0:
        parser.error('--vad-limit must be greater than zero')
    if args.vad_batch_size <= 0:
        parser.error('--vad-batch-size must be greater than zero')
    if args.vad_only and args.reset_errors:
        parser.error('--reset-errors cannot be combined with --vad-only')

    initialize_auth()

    if args.vad_only:
        logger.info(
            "Starting VAD-only daemon: limit=%s, batch_size=%s",
            args.vad_limit,
            args.vad_batch_size,
        )
        cycle = lambda: run_vad_cycle(
            limit=args.vad_limit,
            batch_size=args.vad_batch_size,
        )
    else:
        cycle = lambda: main(reset_errors=args.reset_errors)

    run_cycles(cycle, once=args.once)


if __name__ == '__main__':
    cli()

#%%
