"""Offline VAD timing on cached public Silero audio; never reads application data."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from unittest.mock import patch
import wave

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def benchmark(hub: Path, repetitions: int) -> dict:
    sample = hub / "examples/c++/aepyx.wav"
    model_file = hub / "src/silero_vad/data/silero_vad.jit"
    with wave.open(str(sample), "rb") as source:
        if (source.getsampwidth(), source.getnchannels(), source.getframerate()) != (2, 1, 16000):
            raise ValueError("Expected the public 16 kHz mono PCM16 Silero example")
        audio = np.frombuffer(source.readframes(25 * 16000), dtype="<i2").astype(np.float32) / 32768
    if len(audio) != 25 * 16000:
        raise ValueError("Public example must contain at least 25 seconds")
    # Loading local hub code preserves the real model initializer without a
    # GitHub lookup/download. This CLI trusts only the explicitly selected cache.
    loaded = torch.hub.load(str(hub), "silero_vad", source="local")
    with patch("torch.hub.load", return_value=loaded):
        from jobs.vad import get_voice_prob

    clips = [audio[:160000], audio[160000:320000], audio[320000:]]

    def run() -> dict:
        get_voice_prob(audio[:16000])  # JIT warmup excluded from measurements.
        samples = []
        for _ in range(repetitions):
            cpu, wall = time.process_time(), time.perf_counter()
            probabilities = [get_voice_prob(clip) for clip in clips]
            samples.append({"wallSeconds": time.perf_counter() - wall,
                            "cpuSeconds": time.process_time() - cpu,
                            "probabilities": probabilities})
        # Include non-speech and padding cases in the output equivalence check.
        rng = np.random.default_rng(42)
        controls = {"silence": np.zeros(16000, dtype=np.float32),
                    "noise": rng.normal(0, 0.01, 16000).astype(np.float32),
                    "partialWindow": audio[:311]}
        return {"samples": samples,
                "controlProbabilities": {name: get_voice_prob(value) for name, value in controls.items()},
                "torchThreads": torch.get_num_threads(),
                "interopThreads": torch.get_num_interop_threads()}

    # Production invokes VAD inside an executor thread, not the main thread.
    with ThreadPoolExecutor(max_workers=1) as executor:
        result = executor.submit(run).result()
    return {"audioSecondsPerSample": 25, "ompThreads": os.getenv("OMP_NUM_THREADS"),
            "modelSha256": hashlib.sha256(model_file.read_bytes()).hexdigest(),
            "sampleSha256": hashlib.sha256(sample.read_bytes()).hexdigest(), **result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hub-dir", type=Path, required=True, help="Existing trusted Silero torch.hub cache")
    parser.add_argument("--repetitions", type=int, choices=range(1, 6), default=3)
    arguments = parser.parse_args()
    print(json.dumps(benchmark(arguments.hub_dir.resolve(), arguments.repetitions), indent=2))
