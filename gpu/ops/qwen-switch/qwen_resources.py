"""Read-only Docker, host RAM and NVIDIA resource snapshots (standard library).

Docker CLI MemUsage is its Linux working set, excluding reclaimable cache. Host
used memory is MemTotal minus MemAvailable. These are different accounting views;
neither is added to the other. GPU device usage and attributed compute-process
usage are also separate views, never additive. All values are bytes or None.
"""

import csv
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import io
import json
from pathlib import Path
import re
import subprocess


CANONICAL_FILE_DIARIZATION = "sky-diarization-candidate-diarization-1-1"
LEGACY_PROJECT = "sky-diarization-candidate"
PROC_ROOT = Path("/proc")
LIST_FORMAT = '{"id":{{json .ID}},"name":{{json .Names}},"state":{{json .State}}}'
INSPECT_FORMAT = (
    '{"id":{{json .Id}},"name":{{json .Name}},'
    '"state":{{json .State.Status}},"running":{{json .State.Running}},'
    '"health":{{with index .State "Health"}}{{json (index . "Status")}}{{else}}null{{end}},'
    '"project":{{with index .Config "Labels"}}{{json (index . "com.docker.compose.project")}}{{else}}null{{end}}}'
)
STATS_FORMAT = '{"id":{{json .ID}},"memory":{{json .MemUsage}}}'
ACTIVE_STATES = {"running", "restarting", "paused"}
STOPPED_STATES = {"exited", "created", "dead"}


def parse_bytes(value):
    """Parse a byte quantity or Docker MemUsage; unavailable is never zero."""
    if value is None or isinstance(value, bool):
        return None
    text = str(value).split("/", 1)[0].strip()
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([kmgtpe]?i?b)?", text, re.I)
    if not match:
        return None
    unit = (match[2] or "b").lower()
    power = "bkmgtpe".index(unit[0]) if unit != "b" else 0
    base = 1024 if "i" in unit else 1000
    try:
        return int(Decimal(match[1]) * base ** power)
    except (InvalidOperation, ValueError, OverflowError):
        return None


def _command(args, timeout=6, *, partial_warnings=None):
    try:
        result = subprocess.run(args, capture_output=True, text=True,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode == 0:
        return result.stdout
    if partial_warnings is not None:
        # Batch inspect can fail for one removed container while returning valid
        # JSON for its peers. Keep those records without hiding the failed call.
        partial_warnings.append("Docker inspect returned an error; using any valid details.")
        return result.stdout
    return None


def _json_lines(text):
    if text is None:
        return []
    result = []
    for line in text.splitlines():
        try:
            value = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict):
            result.append(value)
    return result


def _read_text(path):
    try:
        return path.read_text()
    except (OSError, UnicodeError):
        return None


def _host_memory(warnings):
    text = _read_text(PROC_ROOT / "meminfo")
    values = {}
    for line in (text or "").splitlines():
        key, sep, raw = line.partition(":")
        if sep and key in {"MemTotal", "MemAvailable"}:
            # Linux procfs calls binary KiB "kB", unlike Docker's SI units.
            match = re.fullmatch(r"\s*(\d+)\s+kB\s*", raw)
            values[key] = int(match[1]) * 1024 if match else None
    total, available = values.get("MemTotal"), values.get("MemAvailable")
    used = total - available if total is not None and available is not None and 0 <= available <= total else None
    if used is None:
        warnings.append("Host RAM unavailable (MemTotal/MemAvailable).")
    return {"total_bytes": total, "available_bytes": available,
            "used_bytes": used, "accounting": "MemTotal - MemAvailable"}


def _mib(value):
    return parse_bytes(str(value).strip() + " MiB")


def _gpu_resources(warnings):
    gpu_text = _command(["nvidia-smi", "--query-gpu=index,uuid,memory.used,memory.total,memory.free",
                         "--format=csv,noheader,nounits"])
    process_text = _command(["nvidia-smi", "--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory",
                             "--format=csv,noheader,nounits"])
    gpus, processes = [], []
    gpu_valid = gpu_text is not None
    process_valid = process_text is not None
    seen_gpus, seen_processes = set(), set()
    for row in csv.reader(io.StringIO(gpu_text or "")):
        if len(row) != 5 or not row[0].strip().isdigit():
            gpu_valid = False
            continue
        index, uuid, used, total, available = (part.strip() for part in row)
        if uuid in seen_gpus:
            continue
        seen_gpus.add(uuid)
        used_bytes, total_bytes, available_bytes = _mib(used), _mib(total), _mib(available)
        if (used_bytes is None or total_bytes is None or available_bytes is None
                or used_bytes + available_bytes > total_bytes):
            available_bytes = None
        gpus.append({"index": int(index), "uuid": uuid,
                     "used_bytes": used_bytes, "total_bytes": total_bytes,
                     "available_bytes": available_bytes})
    for row in csv.reader(io.StringIO(process_text or "")):
        if not row:
            continue
        if len(row) != 4 or not row[1].strip().isdigit():
            process_valid = False
            continue
        uuid, pid, name, used = (part.strip() for part in row)
        key = (uuid, int(pid))
        if key in seen_processes:
            continue
        seen_processes.add(key)
        processes.append({"gpu_uuid": uuid, "pid": int(pid), "name": name,
                          "vram_bytes": _mib(used), "container_id": None,
                          "container_name": None, "attribution": "unknown"})
    if not gpu_valid or not gpus or any(g["available_bytes"] is None for g in gpus):
        warnings.append("GPU device memory unavailable or incomplete.")
    if not process_valid or any(p["vram_bytes"] is None for p in processes):
        warnings.append("GPU process memory unavailable or incomplete.")
    totals = {
        "used_bytes": _complete_sum(g["used_bytes"] for g in gpus) if gpu_valid and gpus else None,
        "total_bytes": _complete_sum(g["total_bytes"] for g in gpus) if gpu_valid and gpus else None,
        "available_bytes": _complete_sum(g["available_bytes"] for g in gpus) if gpu_valid and gpus else None,
        "process_bytes": _complete_sum(p["vram_bytes"] for p in processes) if process_valid else None,
        "process_query_ok": process_valid,
    }
    return gpus, processes, totals


def _complete_sum(values):
    values = list(values)
    return sum(values) if all(value is not None for value in values) else None


def _top(container_id):
    text = _command(["docker", "top", container_id, "-eo", "pid,comm"], timeout=3)
    if text is None:
        return None
    lines = text.splitlines()
    if not lines or lines[0].split()[:2] != ["PID", "COMMAND"]:
        # Some ps implementations title comm as CMD or COMM.
        if not lines or lines[0].split()[:2] not in (["PID", "CMD"], ["PID", "COMM"]):
            return None
    processes = []
    for line in lines[1:]:
        parts = line.split(None, 1)
        if len(parts) != 2 or not parts[0].isdigit():
            return None
        processes.append({"pid": int(parts[0]), "name": parts[1].strip(), "vram_bytes": None})
    return processes


def _cgroup_owner(pid, containers):
    text = _read_text(PROC_ROOT / str(pid) / "cgroup")
    if text is None:
        return None, "unknown"
    ids = re.findall(r"(?:docker[-/])([a-f0-9]{12,64})(?:\.scope)?(?:/|$)", text, re.M)
    for candidate in ids:
        matches = [c for c in containers if c["id"] and
                   (c["id"].startswith(candidate) or candidate.startswith(c["id"]))]
        if len(matches) == 1:
            return matches[0], "cgroup"
    return None, "unknown" if ids else "host"


def _group(container):
    name = container["name"]
    if name == CANONICAL_FILE_DIARIZATION:
        return "diarization"
    if (name == "sky-diarization-1" or container.get("project") == LEGACY_PROJECT
            or name.startswith(LEGACY_PROJECT + "-")):
        return "legacy-diarization"
    if "omi" in name.lower():
        return "omi"
    if name.startswith("qwen"):
        return "qwen"
    if name.startswith(("mycelia-stt-", "sky-livekit-")):
        return "audio"
    return "other"


def collect_resources(known_names: set[str]):
    """Collect only metadata/metrics; never probe inference APIs or mutate Docker.

    Known names must include the caller's Omi runtime and canonical file diarizer. A
    successful container listing proves missing names absent; a failed listing
    leaves their state unknown. Both have unknown metrics. Confirmed stopped
    containers have zero current RAM/VRAM. Legacy diarizers are shown separately.
    """
    warnings = []
    names = set(known_names)
    listed = _command(["docker", "ps", "-a", "--no-trunc", "--format", LIST_FORMAT])
    containers = []
    for item in _json_lines(listed):
        cid, name = item.get("id"), item.get("name")
        if not isinstance(cid, str) or not re.fullmatch(r"[a-f0-9]{12,64}", cid) or not isinstance(name, str):
            continue
        containers.append({"id": cid, "name": name.lstrip("/"),
                           "state": item.get("state", "unknown"), "health": None,
                           "project": None, "ram_bytes": None, "vram_bytes": None,
                           "processes": None})
    if listed is None:
        warnings.append("Docker container list unavailable.")
    elif listed.strip() and not containers:
        warnings.append("Docker container list could not be parsed.")
        listed = None
    if containers:
        detail_text = _command(["docker", "inspect", "--format", INSPECT_FORMAT,
                                *(c["id"] for c in containers)], partial_warnings=warnings)
        details = {item.get("id"): item for item in _json_lines(detail_text)}
        for container in containers:
            detail = details.get(container["id"])
            if detail:
                for key in ("state", "health", "project"):
                    container[key] = detail.get(key)
            else:
                warnings.append("Container details unavailable: " + container["name"] + ".")
    found = {c["name"] for c in containers}
    for name in sorted(names - found):
        containers.append({"id": None, "name": name,
                           "state": "missing" if listed is not None else "unknown",
                           "health": None, "project": None, "ram_bytes": None,
                           "vram_bytes": None, "processes": None})
    for container in containers:
        container["known"] = container["name"] in names
        container["group"] = _group(container)
        if container["state"] in STOPPED_STATES:
            container.update(ram_bytes=0, vram_bytes=0, processes=[])
    active = [c for c in containers if c["state"] in ACTIVE_STATES and c["id"]]
    if active:
        stats_text = _command(["docker", "stats", "--no-stream", "--no-trunc", "--format", STATS_FORMAT,
                               *(c["id"] for c in active)], timeout=8)
        stats = {item.get("id"): parse_bytes(item.get("memory")) for item in _json_lines(stats_text)}
        for container in active:
            container["ram_bytes"] = stats.get(container["id"])
        if any(c["ram_bytes"] is None for c in active):
            warnings.append("Docker RAM unavailable for one or more running containers.")
        with ThreadPoolExecutor(max_workers=min(6, len(active))) as pool:
            for container, processes in zip(active, pool.map(_top, [c["id"] for c in active])):
                container["processes"] = processes
    host = _host_memory(warnings)
    gpus, processes, gpu = _gpu_resources(warnings)
    pid_owners = {}
    for container in active:
        for process in container["processes"] or []:
            pid_owners.setdefault(process["pid"], []).append(container)
    for process in processes:
        owner, attribution = _cgroup_owner(process["pid"], containers)
        if owner is None and len(pid_owners.get(process["pid"], [])) == 1:
            owner, attribution = pid_owners[process["pid"]][0], "docker top"
        process["attribution"] = attribution
        if owner:
            process["container_id"], process["container_name"] = owner["id"], owner["name"]
    unresolved = any(p["attribution"] == "unknown" for p in processes)
    if unresolved:
        warnings.append("Some GPU processes could not be attributed to a container or host.")
    for container in active:
        owned = [p for p in processes if p["container_id"] == container["id"]]
        measurable = gpu["process_query_ok"] and not (unresolved and container["processes"] is None)
        container["vram_bytes"] = _complete_sum(p["vram_bytes"] for p in owned) if measurable else None
        for process in container["processes"] or []:
            matching = [p for p in processes if p["pid"] == process["pid"] and p["container_id"] == container["id"]]
            process["vram_bytes"] = _complete_sum(p["vram_bytes"] for p in matching) if gpu["process_query_ok"] else None
    known = [c for c in containers if c["known"]]
    totals = {"container_count": len(known)}
    for metric in ("ram", "vram"):
        values = [c[metric + "_bytes"] for c in known]
        totals[metric + "_bytes"] = _complete_sum(values)
        totals[metric + "_measured_bytes"] = sum(value for value in values if value is not None)
        totals[metric + "_unknown_count"] = sum(value is None for value in values)
    return {"collected_at": datetime.now(timezone.utc).isoformat(),
            "containers": sorted(containers, key=lambda c: c["name"]),
            "processes": sorted(processes, key=lambda p: (p["gpu_uuid"], p["pid"])),
            "host": host, "gpus": gpus, "gpu": gpu, "known_totals": totals,
            "warnings": warnings}


def _display(value):
    return "".join(char for char in str(value) if char.isprintable())


def _memory(value):
    if value is None:
        return "?"
    if value == 0:
        return "0"
    return f"{value / 1024 ** 3:.2f} GiB" if value >= 1024 ** 3 else f"{value / 1024 ** 2:.1f} MiB"


def _table(headers, rows):
    clean = [[_display(value) for value in row] for row in [headers, *rows]]
    widths = [max(len(row[index]) for row in clean) for index in range(len(headers))]
    return ["  ".join(value.ljust(width) for value, width in zip(row, widths)).rstrip() for row in clean]


def render_resources(snapshot, full=False):
    """Return compact English text; full adds running services and process PIDs."""
    host, gpu = snapshot["host"], snapshot["gpu"]
    lines = ["Current resources",
             f"Host RAM: {_memory(host['used_bytes'])} / {_memory(host['total_bytes'])}  available {_memory(host['available_bytes'])}",
             f"GPU VRAM: {_memory(gpu['used_bytes'])} / {_memory(gpu['total_bytes'])}  available {_memory(gpu['available_bytes'])}"]
    containers = snapshot["containers"]
    selected = [c for c in containers if c["group"] != "legacy-diarization" and
                (c["known"] or (full and c["state"] in ACTIVE_STATES)) and
                not (c["group"] == "qwen" and c["state"] in STOPPED_STATES)]
    legacy = [c for c in containers if c["group"] == "legacy-diarization"]
    if legacy and not full:
        active_candidates = [c for c in legacy if c["state"] not in STOPPED_STATES]
        lines.append(f"Legacy diarization: {len(active_candidates)} active/unknown, {len(legacy) - len(active_candidates)} stopped (details: processes).")
        legacy = active_candidates
    for title, group in (("Services", selected), ("Legacy diarization", legacy)):
        if not group:
            continue
        lines.extend(["", title])
        rows = [(c["name"], c["state"] + ("/" + c["health"] if c["health"] and c["state"] in ACTIVE_STATES else ""),
                 _memory(c["ram_bytes"]), _memory(c["vram_bytes"])) for c in group]
        lines.extend(_table(("Service", "State", "RAM", "VRAM"), rows))
    totals = snapshot["known_totals"]
    def total_text(metric):
        unknown = totals[metric + "_unknown_count"]
        if unknown:
            return _memory(totals[metric + "_measured_bytes"]) + f" + ? ({unknown} unknown)"
        return _memory(totals[metric + "_bytes"])
    lines.extend(["", "Managed total: RAM " + total_text("ram") + "  VRAM " + total_text("vram")])
    if full:
        active = [c for c in containers if c["state"] in ACTIVE_STATES and c["id"]]
        lines.extend(["", "Container processes (RAM is measured per service above)"])
        rows = [(p["pid"], p["name"], c["name"], c["state"], _memory(p["vram_bytes"]))
                for c in active for p in c["processes"] or []]
        if rows:
            lines.extend(_table(("PID", "Process", "Container", "State", "VRAM"), rows))
        else:
            lines.append("None observed.")
        for container in active:
            if container["processes"] is None:
                lines.append("Processes unavailable: " + _display(container["name"]) + ".")
        lines.extend(["", "GPU compute processes"])
        if snapshot["processes"]:
            rows = [(p["pid"], Path(p["name"]).name, p["container_name"] or p["attribution"],
                     _memory(p["vram_bytes"])) for p in snapshot["processes"]]
            lines.extend(_table(("PID", "Process", "Container", "VRAM"), rows))
        else:
            lines.append("None." if gpu["process_query_ok"] else "Unavailable.")
        for warning in snapshot["warnings"]:
            lines.append("Note: " + _display(warning))
    return "\n".join(lines)
