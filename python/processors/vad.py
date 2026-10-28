#%%
import os
import socket
import sys
from datetime import datetime, timezone
from typing import Any
import time

import numpy as np
import torch


python_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(python_dir)

from lib.config import load_environment
from lib import call_resource
from bson import ObjectId
from chunking import read_codec, sample_rate


torch.set_grad_enabled(False)

#%%

def _get_worker_id() -> str:
    host = socket.gethostname()
    pid = os.getpid()
    return f"py-vad:{host}:{pid}"


def _silero_model() -> tuple[Any, Any]:
    model, utils = torch.hub.load(repo_or_dir="snakers4/silero-vad", model="silero_vad")
    return model, utils


def _max_speech_probability(model: Any, audio: np.ndarray) -> float:
    tensor = torch.from_numpy(audio).float()
    sr = 16000
    window = 512
    model.reset_states()
    total = len(audio)
    max_prob = 0.0
    for start in range(0, total, window):
        chunk = tensor[start : start + window]
        if len(chunk) < window:
            pad = int(window - len(chunk))
            chunk = torch.nn.functional.pad(chunk, (0, pad))
        p = float(model(chunk, sr).item())
        if p > max_prob:
            max_prob = p
    return float(max_prob)


def claim_batch(batch_size: int) -> list[dict[str, Any]]:
    body = {
        "action": "find",
        "collection": "audio_chunks",
        "query": {"vad": None},
        "options": {
            "limit": batch_size,
            "sort": {"start": -1},
        },
    }
    items = call_resource("mongo", body)
    return items or []


def _extract_oid(item: dict[str, Any]) -> ObjectId:
    _id = item.get("_id")
    if isinstance(_id, ObjectId):
        return _id
    if isinstance(_id, dict) and "$oid" in _id:
        return ObjectId(str(_id["$oid"]))
    if isinstance(_id, str):
        return ObjectId(_id)
    raise TypeError("Unsupported _id format in claimed item")


def acknowledge(statuses: list[dict[str, Any]]) -> None:
    if not statuses:
        return
    
    ran_at = datetime.now(timezone.utc)
    operations = []
    
    for status in statuses:
        update_data = {}
        if status["status"] == "done":
            update_data["vad"] = {
                "prob": status.get("prob"),
                "has_speech": status.get("has_speech"),
                "ran_at": ran_at,
            }
        elif status["status"] == "failed":
            update_data["vad"] = {
                "error": status.get("error"),
                "ran_at": ran_at,
            }
        
        operations.append({
            "updateOne": {
                "filter": {"_id": status["id"]},
                "update": {"$set": update_data},
                "upsert": True,
            }
        })

    if not operations:
        return
    
    call_resource(
        "mongo",
        {
            "action": "bulkWrite",
            "collection": "audio_chunks",
            "operations": operations,
        },
    )


def _decode_audio_from_item(item: dict[str, Any]) -> np.ndarray:
    return read_codec(item['data'], codec=item.get("format", "opus"), sample_rate=sample_rate)


def process_once(batch_size: int = 10, threshold: float = 0.5) -> int:
    items = claim_batch(batch_size)
    if not items:
        return 0
    model, _ = _silero_model()
    statuses: list[dict[str, Any]] = []
    for item in items:
        try:
            audio = _decode_audio_from_item(item)
            prob = _max_speech_probability(model, audio)
            statuses.append({
                "id": item['_id'],
                "status": "done",
                "prob": float(prob),
                "has_speech": bool(prob > threshold),
            })
        except Exception as e:
            statuses.append({
                "id": item['_id'],
                "status": "failed",
                "error": str(e),
            })
    acknowledge(statuses)
    return len(items)



def main() -> None:
    load_environment()
    while True:
        processed = process_once()
        print(f"processed {processed} chunks")
        if not processed:
            print("sleeping for 10 seconds")
            time.sleep(10)
        

#%%

if __name__ == "__main__":
    main()



