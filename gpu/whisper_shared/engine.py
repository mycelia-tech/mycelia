"""Keep faster-whisper's complete-file generator and output objects unchanged."""

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
    generator, info = model.transcribe(audio, beam_size=5, **options)
    segments = []
    try:
        for segment in generator:
            job.check()
            segments.append(segment)
        job.check()
    finally:
        close = getattr(generator, "close", None)
        if close:
            close()
    return {
        "language": options.get("language", info.language),
        "segments": segments,
        "text": "".join(segment.text for segment in segments),
    }
