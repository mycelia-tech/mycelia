#%%
from lib.resources import call_resource

untranscribed = call_resource('mongo', {
    "action": "count",
    "collection": "audio_chunks",
    "query": {'transcribed_at': {'$eq': None}, 'processing_by': {'$eq': None}, 'vad.has_speech': True},
})
untranscribed
# %%
untranscribed
# %%
from lib.resources import call_resource
call_resource('timeline', {
    "action": "recalculate",
    "start": "30d",
})
# %%
from lib.resources import call_resource
from datetime import datetime, timedelta
import pytz
import pandas as pd
import matplotlib.pyplot as plt

# Get timeline data for past 30 days with 1-day buckets
end = datetime.now(pytz.UTC)
start = end - timedelta(days=30)

histogram_data = call_resource('mongo', {
    "action": "find",
    "collection": "histogram_1day",
    "query": {
        "start": {"$gte": start},
    },
    "options": {"sort": {"start": -1}, "limit": 100},
})
len(histogram_data)
#%%

# Create DataFrame
df = pd.DataFrame(histogram_data)
df['day'] = pd.to_datetime(df['start']).dt.strftime('%Y.%m.%d')

# Extract counts for each type
df['audio_chunks'] = df['totals'].apply(lambda x: x.get('audio_chunks', {}).get('count', 0) if x else 0)
df['diarizations'] = df['totals'].apply(lambda x: x.get('diarizations', {}).get('count', 0) if x else 0)
df['transcriptions'] = df['totals'].apply(lambda x: x.get('transcriptions', {}).get('count', 0) if x else 0)

df.head()
# %%
# Sort by date for proper display
df_sorted = df.sort_values('start')

fig, axes = plt.subplots(3, 1, figsize=(14, 10), sharex=True)

axes[0].bar(df_sorted['day'], df_sorted['audio_chunks'], color='steelblue')
axes[0].set_ylabel('Audio Chunks')
axes[0].set_title('Timeline Data - 1-day buckets')

axes[1].bar(df_sorted['day'], df_sorted['diarizations'], color='coral')
axes[1].set_ylabel('Diarizations')

axes[2].bar(df_sorted['day'], df_sorted['transcriptions'], color='seagreen')
axes[2].set_ylabel('Transcriptions')
axes[2].set_xlabel('Day')

plt.xticks(rotation=90, ha='right')
plt.tight_layout()
plt.show()
# %%
