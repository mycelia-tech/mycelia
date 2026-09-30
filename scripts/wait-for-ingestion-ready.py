"""Wait for host ingestion startup without waiting for its first audio batch."""

import json
import subprocess
import sys
import time


def fetch_readiness(url: str, timeout: float) -> dict:
    # A socket timeout only bounds each read; a slowly streaming response can
    # exceed it indefinitely. Bound the whole transfer and the child process.
    response = subprocess.run(
        ["/usr/bin/curl", "-fsS", "--max-time", str(timeout), url],
        capture_output=True,
        text=True,
        check=True,
        timeout=timeout,
    )
    return json.loads(response.stdout)


def wait_for_readiness(url: str, timeout: float = 90) -> dict:
    deadline = time.monotonic() + timeout
    last_error = "No readiness response"
    while (remaining := deadline - time.monotonic()) > 0:
        try:
            payload = fetch_readiness(url, timeout=min(2, remaining))
            if time.monotonic() >= deadline:
                raise TimeoutError("Readiness response exceeded the deadline")
            if (
                isinstance(payload, dict)
                and payload.get("service") == "mycelia-host-ingestion"
                and payload.get("status") == "ready"
                and isinstance(payload.get("health"), dict)
                and payload["health"].get("status") in ("starting", "healthy", "degraded")
            ):
                return payload
            last_error = "Unexpected service or readiness response"
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            last_error = str(exc)
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(1, remaining))
    raise TimeoutError(last_error)


def main() -> int:
    try:
        payload = wait_for_readiness(sys.argv[1])
    except TimeoutError as exc:
        print(f"Readiness timeout: {exc}", file=sys.stderr)
        return 1
    health = payload["health"]
    print(f"Host ingestion service ready; ingestion health: {health['status']}")
    print(json.dumps(health, sort_keys=True))
    if health["status"] == "degraded":
        print("Ingestion needs attention; inspect the health details above.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
