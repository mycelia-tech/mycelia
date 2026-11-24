"""Decode complete files and corroborate quiet speech after an empty batch result."""

import logging
import subprocess
from dataclasses import replace

from scheduler import current_job


class FixedFeatureExtractor:
    def __init__(self, extractor):
        self._extractor = extractor

    def __getattr__(self, name):
        return getattr(self._extractor, name)

    def __call__(self, waveform, padding=160, chunk_length=None):
        if chunk_length is not None:
            raise ValueError(
                "shared Whisper requires fixed feature extraction chunk length"
            )
        return self._extractor(waveform, padding=padding, chunk_length=None)


def _decode(model, audio, options, job):
    job.check()
    generator, info = model.transcribe(audio, **options)
    try:
        segments = []
        for segment in generator:
            job.check()
            segments.append(segment)
        job.check()
        return segments, info
    finally:
        close = getattr(generator, "close", None)
        if close:
            close()


def _confirmed_segments(enhanced, reference, include_words):
    """Keep contiguous runs of words that agree in both text and source time."""
    def token(word):
        return word.word.strip().casefold().strip(".,!?…:;—–-«»\"'")

    checks = [word for segment in reference for word in segment.words or []]
    result = []
    cursor = 0
    for segment in enhanced:
        run = []

        def flush():
            if len(run) >= 2:
                result.append(replace(segment, id=len(result), start=run[0].start,
                                      end=run[-1].end, text="".join(w.word for w in run),
                                      words=list(run) if include_words else None, tokens=[]))
            run.clear()

        for word in segment.words or []:
            next_expected = cursor
            while cursor < len(checks) and checks[cursor].end < word.start - 0.5:
                cursor += 1
            match = None
            for i in range(cursor, len(checks)):
                other = checks[i]
                if other.start > word.end + 0.5:
                    break
                if (token(word) and token(word) == token(other)
                        and word.end > word.start and other.end > other.start
                        and min(word.probability, other.probability) >= 0.5
                        and abs(word.start - other.start) <= 0.65
                        and abs(word.end - other.end) <= 0.65):
                    match = i
                    break
            if match is None:
                flush()
            else:
                if run and (match != next_expected or word.start - run[-1].end > 0.8):
                    flush()
                run.append(word)
                cursor = match + 1
        flush()
    return result


def _recover_quiet_file(model, audio, options, job):
    import numpy as np

    if not isinstance(audio, np.ndarray) or audio.ndim != 1 or not 0 < len(audio) <= 60 * 16000:
        return [], None
    rms = np.sqrt(np.mean(np.square(audio)))
    if not 0.0001 <= rms <= 0.02:
        return [], None
    # Run only after an empty file result. Keep sample rate and original time origin.
    try:
        filtered = subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-f", "f32le", "-ar", "16000", "-ac", "1",
            "-i", "pipe:0", "-af", "highpass=f=150,afftdn=nf=-38,volume=12",
            "-f", "f32le", "pipe:1",
        ], input=audio.astype("<f4", copy=False).tobytes(), stdout=subprocess.PIPE,
           stderr=subprocess.DEVNULL, check=True, timeout=8)
    except (OSError, subprocess.SubprocessError):
        logging.getLogger(__name__).warning("Quiet-file noise reduction unavailable")
        return [], None
    cleaned = np.frombuffer(filtered.stdout, dtype="<f4")[:len(audio)].clip(-1, 1)
    timed = {**options, "word_timestamps": True}
    enhanced, info = _decode(model, cleaned, timed, job)
    if not any(len(s.words or []) >= 2 for s in enhanced):
        return [], None
    reference, plain_info = _decode(model, audio, {**timed, "vad_filter": False}, job)
    if plain_info.language != info.language:
        return [], None
    return _confirmed_segments(enhanced, reference, options.get("word_timestamps", False)), info


def transcribe(
    model, audio, task, language, initial_prompt, vad_filter, word_timestamps
):
    job = current_job.get()
    job.check()
    options = {"task": task}
    if language:
        options["language"] = language
    if initial_prompt:
        options["initial_prompt"] = initial_prompt
    if vad_filter:
        options["vad_filter"] = True
    if word_timestamps:
        options["word_timestamps"] = True
    options["beam_size"] = 5
    segments, info = _decode(model, audio, options, job)
    metadata = {}
    if not segments and job.priority == "batch" and task == "transcribe" and vad_filter and not initial_prompt:
        recovered, recovery_info = _recover_quiet_file(model, audio, options, job)
        if recovered:
            segments, info = recovered, recovery_info
            metadata["quietSpeechRecovery"] = "denoised-vad-word-agreement-v1"
    return {
        **({"metadata": metadata} if metadata else {}),
        "language": options.get("language", info.language),
        "segments": segments,
        "text": "".join(segment.text for segment in segments),
    }
