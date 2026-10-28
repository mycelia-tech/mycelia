import hashlib
import numpy as np
import os
import tempfile
import random

from lazy_object_proxy import Proxy as _lazy
from typing import Callable, TypeVar

T = TypeVar('T')


def lazy(factory: Callable[[], T]) -> T:
    return _lazy(factory)

sample_rate = 16000


def flatten(lst):
    return [item for sublist in lst for item in sublist]


def random_string(k=10):
    return "".join(random.choices("abcdefghijklmnopqrstuvwxyz", k=k))

def sha(*args):
    return hashlib.sha256("".join(
        str(arg) for arg in args
    ).encode()).hexdigest()


TMP_DIR = os.path.join(tempfile.gettempdir(), "mycelia")
os.makedirs(TMP_DIR, exist_ok=True)


def get_np_wave(file, start, end):
    from pyannote.core import Segment
    from pyannote.audio import Audio

    audio = Audio(sample_rate=sample_rate, mono='downmix')
    waveform, _ = audio.crop(file, Segment(start, end))
    return np.array(waveform[0])


def get_audio_duration(file):
    import subprocess
    return float(subprocess.check_output([
        "ffprobe", "-i", file, "-show_entries", "format=duration", "-v", "quiet", "-of", "csv=p=0"
    ]))
