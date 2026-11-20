import os
import io
import wave
from datetime import UTC, datetime, timedelta
from pathlib import Path
from sys import path
from unittest import TestCase, main
from unittest.mock import MagicMock, patch

path.insert(0, str(Path(__file__).resolve().parents[1]))

import stt  # noqa: E402


class RemoteTranscriptionTest(TestCase):
    def setUp(self):
        self.previous_server = stt.TRANSCRIPTION_SERVER_URL
        self.previous_key = stt.TRANSCRIPTION_API_KEY
        self.previous_model = stt.TRANSCRIPTION_MODEL
        stt.TRANSCRIPTION_SERVER_URL = "http://stt.example"
        stt.TRANSCRIPTION_API_KEY = "test-key"
        stt.TRANSCRIPTION_MODEL = "whisper"
        stt.REPORTED_TRANSCRIPTION_MODELS.clear()

    def tearDown(self):
        stt.TRANSCRIPTION_SERVER_URL = self.previous_server
        stt.TRANSCRIPTION_API_KEY = self.previous_key
        stt.TRANSCRIPTION_MODEL = self.previous_model
        stt.REPORTED_TRANSCRIPTION_MODELS.clear()

    def test_records_model_from_proxy_header(self):
        response = MagicMock()
        response.headers = {
            "X-Whisper-Model": "large-v3-turbo",
            "X-Whisper-VAD-Filter": "true",
        }
        response.json.return_value = {
            "segments": [],
            "metadata": {"language": "en"},
        }

        with patch("stt.requests.post", return_value=response) as request:
            transcript = stt.transcribe_with_remote_server(b"audio")

        self.assertEqual(
            transcript["metadata"],
            {
                "language": "en",
                "model": "large-v3-turbo",
                "provider": "remote_openai_compatible",
                "whisperVadFilter": True,
            },
        )
        self.assertEqual(request.call_args.kwargs["data"], {"model": "whisper"})

    def test_uses_configured_model_when_header_is_missing(self):
        response = MagicMock()
        response.headers = {}
        response.json.return_value = {"segments": []}

        with (
            patch.dict(os.environ, {"STT_MODEL": "medium"}),
            patch("stt.requests.post", return_value=response),
        ):
            transcript = stt.transcribe_with_remote_server(b"audio")

        self.assertEqual(transcript["metadata"]["model"], "medium")

    def test_sends_and_verifies_requested_model(self):
        stt.TRANSCRIPTION_MODEL = "large-v3"
        response = MagicMock()
        response.headers = {"X-Whisper-Model": "large-v3"}
        response.json.return_value = {"segments": []}

        with patch("stt.requests.post", return_value=response) as request:
            transcript = stt.transcribe_with_remote_server(b"audio")

        self.assertEqual(request.call_args.kwargs["data"], {"model": "large-v3"})
        self.assertEqual(transcript["metadata"]["model"], "large-v3")

    def test_rejects_model_mismatch(self):
        stt.TRANSCRIPTION_MODEL = "large-v3"
        response = MagicMock()
        response.headers = {"X-Whisper-Model": "large-v3-turbo"}
        response.json.return_value = {"segments": []}

        with (
            patch("stt.requests.post", return_value=response),
            self.assertRaisesRegex(RuntimeError, "model mismatch"),
        ):
            stt.transcribe_with_remote_server(b"audio")

    def test_filters_subtitle_credit_and_bounds_saved_segment_to_wav(self):
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
            wav.writeframes(bytes(20 * 16000 * 2))
        sequence = MagicMock()
        sequence.start = datetime(2026, 1, 1, tzinfo=UTC)
        credit = {"text": " СУБТИТРЫ делал DimaTorzok…", "start": 0, "end": 29.98}
        quote = {"text": "А кто сказал: субтитры сделал DimaTorzok?", "start": 19, "end": 29.98}
        word = {"word": "DimaTorzok?", "start": 19, "end": 29.98, "probability": 0.9}
        with (
            patch("stt.combine_chunks_with_ffmpeg", return_value=buffer.getvalue()),
            patch("stt.transcribe_with_remote_server") as transcribe,
            patch("stt.call_resource") as mongo,
        ):
            transcribe.return_value = {"segments": [credit]}
            self.assertIs(stt.transcribe_sequence(sequence), stt.NO_SPEECH_DETECTED)
            mongo.assert_not_called()
            transcribe.return_value = {
                "text": credit["text"] + quote["text"],
                "segments": [credit, {**quote, "words": [word]},
                             {"text": "After", "start": 20, "end": 30}],
                "duration": 30,
            }
            self.assertEqual(stt.transcribe_sequence(sequence), quote["text"])
            doc = mongo.call_args.args[1]["doc"]
            self.assertEqual(doc["text"], quote["text"])
            self.assertEqual(doc["segments"], [{**quote, "end": 20, "words": [{**word, "end": 20}]}])
            self.assertEqual(doc["duration"], 20)
            self.assertEqual(doc["end"], sequence.start + timedelta(seconds=20))


if __name__ == "__main__":
    main()
