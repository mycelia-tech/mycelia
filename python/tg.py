#%%
from datetime import datetime
from pathlib import Path
import json
from lib.resources import call_resource
from lib.api import get_session, ensure_authorized
from lib.config import get_url
import base64
from tqdm import tqdm
import re

export_dir = Path('/Users/igor/Downloads/Telegram Lite/DataExport_2025-12-09 (1)/')

data_file = export_dir / 'result.json'

with open(data_file, 'r') as f:
    data = json.load(f)

def upload_file_to_gridfs(file_path: Path):
    if not file_path.exists():
        print(f"File not found: {file_path}")
        return None
        
    ensure_authorized()
    with open(file_path, "rb") as f:
        file_content = f.read()
        
    encoded = base64.b64encode(file_content).decode('utf-8')
    
    # Metadata
    metadata = {
        "original_path": str(file_path),
        "source": "telegram_import"
    }
    
    payload = {
        "file": encoded,
        "filename": file_path.name,
        "metadata": metadata
    }
    
    upload_url = get_url("api", "files", "upload")
    try:
        session = get_session()
        response = session.post(upload_url, json=payload)
        response.raise_for_status()
        return response.json().get("file_id")
    except Exception as e:
        print(f"Failed to upload {file_path}: {e}")
        return None

#%%

print(list(data.keys())) 
# ['about', 'personal_information', 'profile_pictures', 'stories', 'contacts', 'frequent_contacts', 'other_data', 'chats', 'left_chats']

# %%

data['chats']['list'][0].keys()
# ['name', 'type', 'id', 'messages']

# %%
# Import all chats from the export

all_chats = data['chats']['list']
print(f"Found {len(all_chats)} chats to import")

for chat_idx, target_chat in enumerate(all_chats):
    messages = target_chat.get('messages', [])

    print(f"\n[{chat_idx + 1}/{len(all_chats)}] Importing chat: {target_chat.get('name', 'Unknown')} (ID: {target_chat['id']})")
    print(f"Total messages: {len(messages)}")

    if not messages:
        print("No messages, skipping.")
        continue

    batch_size = 1000
    message_batch = []
    total_processed = 0

    for msg in tqdm(messages, desc=f"Chat {chat_idx + 1}"):
        # Skip service messages without ID
        if 'id' not in msg:
            continue

        # Skip messages without sender
        if 'from_id' not in msg:
            continue

        msg_external_id = msg['id']
        timestamp = datetime.fromtimestamp(int(msg['date_unixtime']))

        # Parse Telegram from_id (e.g., 'user84380711' -> 84380711)
        from_id_str = msg['from_id']
        match = re.search(r'\d+', from_id_str)
        if not match:
            continue

        telegram_user_id = int(match.group())
        sender_name = msg.get('from', f'Telegram User {telegram_user_id}')

        # Extract text from message (handle both string and array formats)
        text_content = msg.get('text')
        if isinstance(text_content, list):
            text_parts = []
            for item in text_content:
                if isinstance(item, str):
                    text_parts.append(item)
                elif isinstance(item, dict) and 'text' in item:
                    text_parts.append(item['text'])
            text_content = ''.join(text_parts)
        elif text_content is None:
            text_content = ''

        # Handle media (currently commented out - can be enabled later)
        media_items = []

        # # Check for photo
        # if 'photo' in msg:
        #     photo_path = export_dir / msg['photo']
        #     file_id = upload_file_to_gridfs(photo_path)
        #     if file_id:
        #         media_items.append({
        #             "type": "image",
        #             "url": f"/api/files/{file_id}",
        #             "fileId": file_id,
        #             "path": msg['photo'],
        #             "fileName": Path(msg['photo']).name
        #         })

        # # Check for file
        # if 'file' in msg:
        #     file_path = export_dir / msg['file']
        #     file_id = upload_file_to_gridfs(file_path)
        #     if file_id:
        #         media_type = "file"
        #         if msg.get('media_type') in ['voice_message', 'audio_file']:
        #             media_type = "audio"
        #         elif msg.get('media_type') in ['video_message', 'video_file', 'animation']:
        #             media_type = "video"
        #         elif msg.get('media_type') == 'sticker':
        #             media_type = "sticker"

        #         media_items.append({
        #             "type": media_type,
        #             "url": f"/api/files/{file_id}",
        #             "fileId": file_id,
        #             "path": msg['file'],
        #             "fileName": Path(msg['file']).name,
        #             "mimeType": msg.get('mime_type')
        #         })

        # Build message for messenger resource
        message_data = {
            "platform": "telegram",
            "chatExternalId": target_chat['id'],
            "externalId": msg_external_id,
            "timestamp": timestamp,
            "senderExternalId": telegram_user_id,
            "senderName": sender_name,
            "text": text_content,
            "raw": msg,
        }

        # Add optional chat metadata (will be used if chat needs to be created)
        if target_chat.get('name'):
            message_data["chatName"] = target_chat.get('name')

        if media_items:
            message_data["media"] = media_items

        message_batch.append(message_data)

        # Process batch when it reaches batch_size
        if len(message_batch) >= batch_size:
            try:
                result = call_resource("messenger", {
                    "action": "upsertMessageBatch",
                    "messages": message_batch
                })
                total_processed += result['processed']
                print(f"  Batch: {result['processed']} processed, {result['created']} created (total: {total_processed}/{len(messages)})")
                message_batch = []
            except Exception as e:
                print(f"  Error processing batch: {e}")
                print(f"  Batch size: {len(message_batch)} messages")
                if hasattr(e, 'response') and hasattr(e.response, 'text'):
                    print(f"  Response: {e.response.text[:500]}")
                message_batch = []

    # Flush remaining messages for this chat
    if message_batch:
        try:
            result = call_resource("messenger", {
                "action": "upsertMessageBatch",
                "messages": message_batch
            })
            total_processed += result['processed']
            print(f"  Final batch: {result['processed']} processed, {result['created']} created (total: {total_processed}/{len(messages)})")
        except Exception as e:
            print(f"  Error processing final batch: {e}")
            print(f"  Batch size: {len(message_batch)} messages")
            if hasattr(e, 'response') and hasattr(e.response, 'text'):
                print(f"  Response: {e.response.text[:500]}")

print("\nAll chats imported.")
