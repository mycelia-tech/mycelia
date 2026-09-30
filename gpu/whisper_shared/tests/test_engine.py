import unittest
from types import SimpleNamespace

from engine import FixedFeatureExtractor, transcribe
from scheduler import Cancelled, Scheduler, current_job


class EngineTests(unittest.TestCase):
    def test_single_native_generator_options_words_and_cleanup(self):
        s = Scheduler(2)
        j = s.admit("batch", 10)
        calls, closed = [], []

        class Stub:
            def transcribe(self, audio, **kwargs):
                calls.append((audio, kwargs))

                def gen():
                    try:
                        yield SimpleNamespace(text=" one", words=["real-word"])
                        yield SimpleNamespace(text=" two", words=[])
                    finally:
                        closed.append(True)

                return gen(), SimpleNamespace(language="ru")

        token = current_job.set(j)
        try:
            result = transcribe(
                Stub(),
                "entire audio",
                task="translate",
                language=None,
                initial_prompt="context",
                vad_filter=True,
                word_timestamps=True,
            )
        finally:
            current_job.reset(token)
            s.finish(j)
        self.assertEqual(result["text"], " one two")
        self.assertEqual(result["language"], "ru")
        self.assertEqual(result["segments"][0].words, ["real-word"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(
            calls[0][1],
            {
                "beam_size": 5,
                "task": "translate",
                "initial_prompt": "context",
                "vad_filter": True,
                "word_timestamps": True,
            },
        )
        self.assertEqual(closed, [True])

    def test_fixed_feature_extractor_rejects_shared_configuration_mutation(self):
        class Features:
            sampling_rate = 16000

            def __call__(self, audio, padding=160, chunk_length=None):
                return (audio, padding, chunk_length)

        features = FixedFeatureExtractor(Features())
        self.assertEqual(features.sampling_rate, 16000)
        self.assertEqual(features("audio"), ("audio", 160, None))
        with self.assertRaises(ValueError):
            features("audio", chunk_length=10)

    def test_cancellation_closes_native_generator(self):
        s = Scheduler(2)
        j = s.admit("batch", 10)
        closed = []

        class Stub:
            def transcribe(self, audio, **kwargs):
                def gen():
                    try:
                        s.cancel(j)
                        yield SimpleNamespace(text="cancelled")
                    finally:
                        closed.append(True)

                return gen(), SimpleNamespace(language="en")

        token = current_job.set(j)
        try:
            with self.assertRaises(Cancelled):
                transcribe(
                    Stub(),
                    "audio",
                    task="transcribe",
                    language="en",
                    initial_prompt=None,
                    vad_filter=False,
                    word_timestamps=False,
                )
        finally:
            current_job.reset(token)
            s.finish(j)
        self.assertEqual(closed, [True])
