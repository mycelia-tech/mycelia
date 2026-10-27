import pyaudio
import wave
import sqlite3
import threading
import requests
import time
import io
import argparse
import os
from datetime import datetime, timezone
from typing import Optional
from lib.config import allow_insecure_transport, env, get_url, load_environment
from oauthlib.oauth2 import BackendApplicationClient
from requests_oauthlib import OAuth2Session


CHUNK_SIZE = 1024
FORMAT = pyaudio.paInt16
CHANNELS = 1
RATE = 16000
CHUNK_DURATION_SECONDS = 10
FRAMES_PER_CHUNK = int(RATE * CHUNK_DURATION_SECONDS)


class PersistentQueue:
    def __init__(self, db_path: str = "audio_queue.db"):
        self.db_path = db_path
        self.connection = sqlite3.connect(db_path, check_same_thread=False)
        self.lock = threading.Lock()
        self._initialize_db()
    
    def _initialize_db(self):
        with self.lock:
            cursor = self.connection.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS audio_chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT NOT NULL,
                    chunk_number INTEGER NOT NULL,
                    source_file_id TEXT,
                    audio_data BLOB NOT NULL,
                    recording_start TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
            """)
            self.connection.commit()
    
    def enqueue(self, audio_data: bytes, chunk_number: int, source_file_id: Optional[str], recording_start: str):
        with self.lock:
            cursor = self.connection.cursor()
            cursor.execute("""
                INSERT INTO audio_chunks (timestamp, chunk_number, source_file_id, audio_data, recording_start, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (
                datetime.now(timezone.utc).isoformat(),
                chunk_number,
                source_file_id,
                audio_data,
                recording_start,
                datetime.now(timezone.utc).isoformat()
            ))
            self.connection.commit()
            return cursor.lastrowid
    
    def dequeue(self) -> Optional[tuple]:
        with self.lock:
            cursor = self.connection.cursor()
            cursor.execute("""
                SELECT id, timestamp, chunk_number, source_file_id, audio_data, recording_start
                FROM audio_chunks
                ORDER BY id ASC
                LIMIT 1
            """)
            row = cursor.fetchone()
            return row
    
    def remove(self, chunk_id: int):
        with self.lock:
            cursor = self.connection.cursor()
            cursor.execute("DELETE FROM audio_chunks WHERE id = ?", (chunk_id,))
            self.connection.commit()
    
    def get_queue_size(self) -> int:
        with self.lock:
            cursor = self.connection.cursor()
            cursor.execute("SELECT COUNT(*) FROM audio_chunks")
            return cursor.fetchone()[0]
    
    def close(self):
        self.connection.close()


class AudioRecorder:
    def __init__(self, server_url: str, client_id: str, client_secret: str):
        self.server_url = server_url
        self.client_id = client_id
        self.client_secret = client_secret
        self.persistent_queue = PersistentQueue()
        self.audio = pyaudio.PyAudio()
        self.stream = None
        self.is_recording = False
        self.chunk_number = 0
        self.source_file_id = None
        self.recording_start = None
        self.worker_thread = None
        self.stop_event = threading.Event()
        self.oauth_session = None
        self._authenticate()
    
    def _authenticate(self):
        client = BackendApplicationClient(client_id=self.client_id)
        self.oauth_session = OAuth2Session(client=client)
        token_url = get_url('oauth', 'token')
        
        try:
            self.oauth_session.fetch_token(
                token_url=token_url,
                client_id=self.client_id,
                client_secret=self.client_secret
            )
            print("✓ Authenticated successfully")
        except Exception as e:
            print(f"✗ Authentication failed: {e}")
            raise
    
    def _refresh_token_if_needed(self):
        if self.oauth_session.token.get('expires_at', 0) < time.time() + 60:
            try:
                token_url = get_url('oauth', 'token')
                self.oauth_session.fetch_token(
                    token_url=token_url,
                    client_id=self.client_id,
                    client_secret=self.client_secret
                )
                print("✓ Token refreshed")
            except Exception as e:
                print(f"✗ Token refresh failed: {e}")
    
    def _create_wav_bytes(self, frames: list) -> bytes:
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(self.audio.get_sample_size(FORMAT))
            wf.setframerate(RATE)
            wf.writeframes(b''.join(frames))
        return buffer.getvalue()
    
    def _upload_worker(self):
        print("✓ Upload worker started")
        retry_delay = 1
        max_retry_delay = 60
        
        while not self.stop_event.is_set():
            try:
                chunk_data = self.persistent_queue.dequeue()
                
                if not chunk_data:
                    time.sleep(0.5)
                    continue
                
                chunk_id, timestamp, chunk_number, source_file_id, audio_data, recording_start = chunk_data
                
                self._refresh_token_if_needed()
                
                files = {
                    'audio': (f'chunk_{chunk_number}.wav', io.BytesIO(audio_data), 'audio/wav')
                }
                
                data = {
                    'start': timestamp,
                    'chunk_number': chunk_number,
                    'metadata': {
                        'chunk_duration_ms': CHUNK_DURATION_SECONDS * 1000,
                        'streaming': True,
                        'recording_start': recording_start
                    }
                }
                
                if source_file_id:
                    data['source_file_id'] = source_file_id
                
                form_data = {
                    'data': (None, str(data).replace("'", '"'))
                }
                
                upload_url = get_url('api', 'audio', 'ingest')
                response = self.oauth_session.post(upload_url, files=files, data=form_data, timeout=30)
                
                if response.status_code == 200:
                    result = response.json()
                    if chunk_number == 0:
                        self.source_file_id = result.get('source_file_id')
                        print(f"✓ Chunk {chunk_number} uploaded, source_file_id: {self.source_file_id}")
                    else:
                        print(f"✓ Chunk {chunk_number} uploaded")
                    
                    self.persistent_queue.remove(chunk_id)
                    retry_delay = 1
                else:
                    print(f"✗ Upload failed with status {response.status_code}: {response.text}")
                    time.sleep(retry_delay)
                    retry_delay = min(retry_delay * 2, max_retry_delay)
            
            except requests.exceptions.RequestException as e:
                print(f"✗ Network error: {e}. Retrying in {retry_delay}s...")
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, max_retry_delay)
            
            except Exception as e:
                print(f"✗ Unexpected error in worker: {e}")
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, max_retry_delay)
        
        print("✓ Upload worker stopped")
    
    def start_recording(self):
        if self.is_recording:
            print("Already recording")
            return
        
        self.recording_start = datetime.now(timezone.utc).isoformat()
        self.chunk_number = 0
        self.source_file_id = None
        
        self.stream = self.audio.open(
            format=FORMAT,
            channels=CHANNELS,
            rate=RATE,
            input=True,
            frames_per_buffer=CHUNK_SIZE
        )
        
        self.is_recording = True
        self.stop_event.clear()
        
        self.worker_thread = threading.Thread(target=self._upload_worker, daemon=True)
        self.worker_thread.start()
        
        print(f"✓ Recording started (rate: {RATE}Hz, channels: {CHANNELS}, chunk duration: {CHUNK_DURATION_SECONDS}s)")
        print(f"  Queue size: {self.persistent_queue.get_queue_size()} chunks pending")
        
        try:
            while self.is_recording:
                frames = []
                for _ in range(0, FRAMES_PER_CHUNK, CHUNK_SIZE):
                    data = self.stream.read(CHUNK_SIZE, exception_on_overflow=False)
                    frames.append(data)
                
                audio_bytes = self._create_wav_bytes(frames)
                
                self.persistent_queue.enqueue(
                    audio_bytes,
                    self.chunk_number,
                    self.source_file_id,
                    self.recording_start
                )
                
                queue_size = self.persistent_queue.get_queue_size()
                print(f"→ Chunk {self.chunk_number} captured ({len(audio_bytes)} bytes, queue: {queue_size})")
                
                self.chunk_number += 1
        
        except KeyboardInterrupt:
            print("\n✓ Recording interrupted by user")
        except Exception as e:
            print(f"\n✗ Recording error: {e}")
        finally:
            self.stop_recording()
    
    def stop_recording(self):
        if not self.is_recording:
            return
        
        self.is_recording = False
        
        if self.stream:
            self.stream.stop_stream()
            self.stream.close()
        
        print("✓ Waiting for upload worker to finish...")
        self.stop_event.set()
        
        if self.worker_thread and self.worker_thread.is_alive():
            self.worker_thread.join(timeout=5)
        
        remaining = self.persistent_queue.get_queue_size()
        if remaining > 0:
            print(f"⚠ {remaining} chunks remain in queue (will upload on next run)")
        
        print("✓ Recording stopped")
    
    def cleanup(self):
        self.stop_recording()
        self.persistent_queue.close()
        self.audio.terminate()


def main():
    load_environment()
    if allow_insecure_transport():
        os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"
    client_id, client_secret = env("MYCELIA_CLIENT_ID"), env("MYCELIA_TOKEN")
    parser = argparse.ArgumentParser(description='Record audio and stream to Mycelia server')
    parser.add_argument('--db', default='audio_queue.db', help='Path to queue database file')
    parser.parse_args()
    
    if not client_id or not client_secret:
        print("✗ Error: MYCELIA_CLIENT_ID and MYCELIA_TOKEN must be set in .env")
        return 1
    
    recorder = AudioRecorder(
        server_url=get_url('api', 'audio', 'ingest'),
        client_id=client_id,
        client_secret=client_secret
    )
    
    try:
        recorder.start_recording()
    except KeyboardInterrupt:
        print("\n✓ Shutting down...")
    finally:
        recorder.cleanup()
    
    return 0


if __name__ == '__main__':
    exit(main())

