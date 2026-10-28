#!/usr/bin/env python3
"""
Backfill device info for voice memo source_files that don't have it yet.

Usage:
    cd python
    uv run debug/backfill_devices.py              # Backfill up to 100 records
    uv run debug/backfill_devices.py --limit 500  # Backfill up to 500 records
    uv run debug/backfill_devices.py --all        # Backfill all records
    uv run debug/backfill_devices.py --stats      # Show device stats only
"""
import argparse
import os
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from discovery import extract_device_info
from lib.resources import call_resource
from lib.config import load_environment


def get_device_stats():
    """Get statistics on device info in source_files."""
    pipeline = [
        {"$match": {"platform.importer": "apple_voicememos"}},
        {
            "$group": {
                "_id": "$device.device_type",
                "count": {"$sum": 1},
            }
        },
        {"$sort": {"count": -1}},
    ]

    stats = call_resource('mongo', {
        "action": "aggregate",
        "collection": "source_files",
        "pipeline": pipeline,
    })

    return stats or []


def show_stats():
    """Display device statistics."""
    stats = get_device_stats()

    total = sum(s['count'] for s in stats)
    with_device = sum(s['count'] for s in stats if s['_id'] is not None)
    without_device = sum(s['count'] for s in stats if s['_id'] is None)

    print("\n📊 DEVICE INFO STATISTICS")
    print("=" * 50)
    print(f"\nTotal voice memos: {total}")
    print(f"With device info:  {with_device} ({100*with_device/total:.1f}%)" if total > 0 else "")
    print(f"Missing device:    {without_device} ({100*without_device/total:.1f}%)" if total > 0 else "")

    print("\n📱 BY DEVICE TYPE:")
    print("-" * 40)
    for stat in stats:
        device_type = stat['_id'] or '(no device info)'
        count = stat['count']
        pct = 100 * count / total if total > 0 else 0
        print(f"  {device_type:<20} {count:>6} ({pct:>5.1f}%)")

    return without_device


def backfill_device_info(limit=None, verbose=False):
    """Backfill device info for records without it."""
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
        print("✓ All voice memos already have device info!")
        return 0

    find_args = {
        "action": "find",
        "collection": "source_files",
        "query": query,
    }
    if limit:
        find_args["limit"] = limit

    records = call_resource('mongo', find_args)

    process_count = min(limit, total_missing) if limit else total_missing
    print(f"\n🔄 Processing {process_count} of {total_missing} records without device info...\n")

    updated = 0
    skipped = 0
    errors = 0

    for i, record in enumerate(records, 1):
        path = record.get('path')
        filename = os.path.basename(path) if path else str(record['_id'])

        if not path or not os.path.exists(path):
            skipped += 1
            if verbose:
                print(f"  [{i}/{process_count}] ⏭️  Skipped (file not found): {filename}")
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
                if verbose:
                    print(f"  [{i}/{process_count}] ✅ {filename}: {device_info.get('device_type')}")
            else:
                skipped += 1
                if verbose:
                    print(f"  [{i}/{process_count}] ⏭️  No device info found: {filename}")
        except Exception as e:
            errors += 1
            if verbose:
                print(f"  [{i}/{process_count}] ❌ Error: {filename}: {e}")

    remaining = total_missing - updated - skipped

    print(f"\n{'=' * 50}")
    print(f"✅ Updated:   {updated}")
    print(f"⏭️  Skipped:   {skipped}")
    print(f"❌ Errors:    {errors}")
    print(f"📋 Remaining: {remaining}")

    return updated


def main():
    load_environment()
    parser = argparse.ArgumentParser(
        description="Backfill device info for voice memo source_files",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--limit", "-l",
        type=int,
        default=100,
        help="Maximum records to process (default: 100)"
    )
    parser.add_argument(
        "--all", "-a",
        action="store_true",
        help="Process all records (no limit)"
    )
    parser.add_argument(
        "--stats", "-s",
        action="store_true",
        help="Show device statistics only, don't backfill"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Show progress for each file"
    )
    args = parser.parse_args()

    if args.stats:
        show_stats()
        return

    limit = None if args.all else args.limit
    backfill_device_info(limit=limit, verbose=args.verbose)

    print("\n")
    show_stats()


if __name__ == "__main__":
    main()
