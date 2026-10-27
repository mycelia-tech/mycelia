#%%
from lib.resources import call_resource
from bson import ObjectId
from datetime import datetime, timedelta

from pytz import UTC

start = datetime.fromtimestamp(1744669200, tz=UTC)
end = start + timedelta(seconds=25)


diarizations = call_resource('mongo', {
    "action": "find",
    "collection": "diarizations",
    "query": {
        # "original_id": ObjectId('67fdf46123a11a7258153474'),
        "start": {"$lte": end + timedelta(seconds=50) },
    },
    "options": {
        "sort": {"start": -1},
        "limit": 5000,
    },
})

diarizations.reverse()
# %%

import pandas as pd
import numpy as np
df = pd.DataFrame(diarizations)

# Convert embeddings to numpy arrays, handling None/missing values
df['embedding'] = df['embedding'].apply(lambda x: np.array(x) if x is not None else None)

# Filter out rows with missing embeddings
df = df[df['embedding'].notna()].copy()

# Calculate duration for each segment in seconds
df['duration'] = (df['end'] - df['start']).dt.total_seconds()

df['start_rel'] = (df['start'] - start).dt.total_seconds()
df['end_rel'] = (df['end'] - start).dt.total_seconds()

# %%

len(diarizations)
# %%
# %%




KNOWN_SPEAKERS = {
    'tigor': {
        'color': 'pink',
        'known_diarizations': {
            '67fed55d7ce486f7496d2d81',
            '67fec685f64cc2a88352056d',
            '67fed5867ce486f7496d2d8c',
            '67fed8cb573b7e8abb1c2215',
            '67fed5e17ce486f7496d2dd7',
            '67fed949573b7e8abb1c228f',
            '67fed75a573b7e8abb1c213c',
        },
    },
    'alena': {
        'color': 'orange',
        'known_diarizations': {
            '67fed55d7ce486f7496d2d87',
            '67fed893573b7e8abb1c21f8',
            '67fed91e573b7e8abb1c2274',
            '67fed91e573b7e8abb1c2270',
        },
    },
    'noise': {
        'color': 'gray',
        'known_diarizations': {
            '67fedd78573b7e8abb1c2370',
            '67fedd35573b7e8abb1c2353',
        },
    },
    'alisochka': {
        'color': 'red',
        'known_diarizations': {
            '67fed91e573b7e8abb1c226d',
        },
    },
    'dasha_d': {
        'color': 'blue',
        'known_diarizations': {
            '6928cc072f0a9afef97b3f65',
        },
    },
    'random_person_1': {
        'color': 'purple',
        'known_diarizations': {
            '67fef84b573b7e8abb1c2d1c',
        },
    },
}

def get_speaker_by_id(diarization_id: str) -> str | None:
    for speaker_name, speaker_data in KNOWN_SPEAKERS.items():
        if str(diarization_id) in speaker_data['known_diarizations']:
            return speaker_name
    return None

speaker_average_embeddings = {}
for speaker_name, speaker_data in KNOWN_SPEAKERS.items():
    speaker_diarizations = call_resource('mongo', {
        "action": "find",
        "collection": "diarizations",
        "query": {
            "_id": {"$in": list(ObjectId(id) for id in speaker_data['known_diarizations'])},
        },
    })
    print(f"{speaker_name}: {len(speaker_diarizations)} diarizations")
    speaker_average_embeddings[speaker_name] = np.mean([diarization['embedding'] for diarization in speaker_diarizations], axis=0)


# %%

# %%

from sklearn.decomposition import PCA

# Cluster embeddings to assign a speaker label to each point
# grow clusters from known points

import numpy as np
from sklearn.metrics.pairwise import cosine_similarity

# Prepare arrays
X = np.stack(df['embedding'].values)  # np.ndarray shape (n_samples, embedding_dim)
id_to_row = {str(row['_id']): i for i, row in df.iterrows()}

# Create mapping from DataFrame index to sequential array position
df_index_to_position = {idx: pos for pos, idx in enumerate(df.index)}

# Gather indices of known speakers (as DataFrame indices)
labeled_df_idx = []
labeled_labels = []
for idx, row in df.iterrows():
    id_ = str(row['_id'])
    speaker = get_speaker_by_id(id_)
    if speaker is not None:
        labeled_df_idx.append(idx)
        labeled_labels.append(speaker)

# Convert DataFrame indices to sequential array positions
labeled_idx = [df_index_to_position[idx] for idx in labeled_df_idx]
        
# Make a mapping to cluster IDs for each label
label_names = sorted(list(set(labeled_labels)))
label_to_cluster = {name: i for i, name in enumerate(label_names)}
labeled_y = np.array([label_to_cluster[label] for label in labeled_labels])

# Indices of unlabeled points (as sequential positions)
all_idx = set(range(len(df)))
unlabeled_idx = list(all_idx - set(labeled_idx))

# Grow clusters: label propagation based on embedding similarity
from sklearn.semi_supervised import LabelSpreading

labels = -1 * np.ones(len(df), dtype=int)
labels[labeled_idx] = labeled_y

def angular_kernel(X, Y=None):
    if Y is None:
        Y = X

    # cosine distance: 0 = same, 2 = opposite
    cos = cosine_similarity(X, Y)
    dist = 1 - cos

    # Convert distance → weight, e.g. RBF-like:
    gamma = 5
    W = np.exp(-gamma * dist)
    return W

# LabelSpreading requires unique label indices (not names)
label_spreader = LabelSpreading(kernel=angular_kernel, alpha=0.5)
label_spreader.fit(X, labels)
all_pred = label_spreader.transduction_  # array of label indices

# Map back from cluster index to speaker name
inv_label_map = {i: name for name, i in label_to_cluster.items()}
pred_speaker = np.array([inv_label_map.get(idx) if idx in inv_label_map else None for idx in all_pred])

# Add the predicted speaker to the DataFrame
df['predicted_speaker'] = pred_speaker


#%% 

import matplotlib.pyplot as plt

# Use the speaker cluster index (y-axis) directly, instead of PCA
# This means each speaker label will be plotted as its discrete cluster index

fig, ax = plt.subplots(figsize=(12, 3.5))
for name in label_names:
    color = KNOWN_SPEAKERS.get(name, {}).get('color', 'gray')
    if color == 'gray':
        continue
    speaker_idx = label_to_cluster[name]
    mask = df['predicted_speaker'] == name
    labeled_mask = mask & df.index.isin(labeled_idx)
    unlabeled_mask = mask & ~df.index.isin(labeled_idx)
    # Plot unlabeled as circles
    ax.scatter(df.loc[unlabeled_mask, 'start_rel'], [speaker_idx] * unlabeled_mask.sum(), color=color, label=name, marker='o', s=36, alpha=0.8)
    # Plot labeled as crosses
    ax.scatter(df.loc[labeled_mask, 'start_rel'], [speaker_idx] * labeled_mask.sum(), color=color, marker='x', s=90, linewidths=2, alpha=0.9)
ax.set_xlabel('Start (ms, relative)')
ax.set_ylabel('Speaker Index')
ax.set_title('Timeline vs Speaker Index (color = predicted_speaker)')
ax.legend(loc='upper right', bbox_to_anchor=(1.14, 1), title='Predicted Speaker')
plt.tight_layout()
plt.show()


#%%

# Get top 10 uncertain points about which cluster to use

# Compute soft label/posterior probabilities for each sample from the label spreader
proba = label_spreader.label_distributions_

# For each sample, compute the entropy of the predicted distribution
from scipy.stats import entropy

uncertainty = entropy(proba.T)  # shape: (n_samples,)

# Consider only unlabeled points
uncertainty_unlabeled = [(idx, uncertainty[idx]) for idx in unlabeled_idx]
# Sort by highest uncertainty (descending)
uncertainty_unlabeled_sorted = sorted(uncertainty_unlabeled, key=lambda x: -x[1])

# Get indices of top 10 most uncertain points
top_uncertain = [idx for idx, _ in uncertainty_unlabeled_sorted[:100]]

# Get their info from the DataFrame
top_uncertain_df = df.iloc[top_uncertain][['_id', 'start_rel', 'duration', 'predicted_speaker']]

top_uncertain_df.sample(10)


# %%


import numpy as np
import pandas as pd

# Assume: 
# - There is a reference "etalon" embedding called `etalon_embedding` (np.ndarray)
# - There is a DataFrame `df_diarizations` with columns: "id", "embedding", "start", "end"
#   where "embedding" column contains array-like voice embeddings

mask = (
    # (df['embedding_dist'] >= 0.25) &
    # (df['embedding_dist'] <= 0.35) &
    # (df['duration'] < 30) & 
    (df['start_rel'] > -7687)
    # (df['start_rel'] < -7587)
    # (df['predicted_speaker'] != 'tigor') &
    # (df['duration'] > 2)

)

# get random 5 rows from df[mask]
df[mask].sort_values(by='start_rel')[[
    '_id', 'start_rel', 'duration', 'predicted_speaker'
]].head(40)

#%%


# %%

import subprocess

def download_by_id(diarization_id: str, pad_seconds: int = 0):
    diarization = call_resource('mongo', {
        "action": "findOne",
        "collection": "diarizations",
        "query": {
            "_id": ObjectId(diarization_id),
        },
    })

    cmd = ' '.join((
        'uv run play.py',
        str(int(diarization['start'].timestamp() - pad_seconds)),
        str(int(diarization['end'].timestamp() + pad_seconds)),
        '-o',
        f'{diarization['_id']}.local.wav',
    ))
    subprocess.run(cmd, shell=True, check=True)
    return f'{diarization_id}.local.wav'


import numpy as np
from IPython.display import Audio, display
def display_by_id(diarization_id: str):
    file = download_by_id(diarization_id, pad_seconds=1)
    w = Audio(file)
    display(w)

display_by_id('67fed55d7ce486f7496d2d81')
# %%



diarization = call_resource('mongo', {
        "action": "findOne",
        "collection": "diarizations",
        "query": {
            "_id": ObjectId('67ff01b1573b7e8abb1c3360'),
            # "start": {
            #     "$gte": datetime.fromtimestamp(1741954471, tz=UTC),
            #     "$lte": datetime.fromtimestamp(1741954471 + 600, tz=UTC),
            # },
        },
    })
diarization

# %%
diarization['start'].timestamp()

# %%

import matplotlib.pyplot as plt
from matplotlib.colors import hsv_to_rgb

# Stack embeddings from DataFrame
embeddings = np.stack(df['embedding'].values)

# Fit 1D PCA
pca = PCA(n_components=1)
X_pca = pca.fit_transform(embeddings)

# Extract normalization parameters
pca_min = np.min(X_pca, axis=0)
pca_max = np.max(X_pca, axis=0)
pca_range = pca_max - pca_min + 1e-9

# Normalize PCA to 0-1 range for hue
hue = (X_pca - pca_min) / pca_range
hue = np.clip(hue.flatten(), 0, 1)

# Store parameters for future use
pca_params = {
    'pca': pca,
    'pca_min': pca_min,
    'pca_range': pca_range,
}

print("PCA parameters extracted:")
print(f"  PCA mean: {pca.mean_}")
print(f"  PCA components: {pca.components_}")
print(f"  PCA min: {pca_min}")
print(f"  PCA max: {pca_max}")
print(f"  PCA range: {pca_range}")

# Save PCA parameters to JSON
import json

pca_params_json = {
    'n_components': int(pca.n_components_),
    'mean': pca.mean_.tolist(),
    'components': pca.components_.tolist(),
    'pca_min': pca_min.tolist(),
    'pca_range': pca_range.tolist(),
}

with open('pca.local.json', 'w') as f:
    json.dump(pca_params_json, f, indent=2)

print("\nPCA parameters saved to pca.local.json")

# Convert hue to RGB with max saturation
# HSV: hue (0-1), saturation (1.0 = max), value (1.0 = max brightness)
saturation = 1.0
value = 1.0
hsv_colors = np.column_stack([hue, np.full_like(hue, saturation), np.full_like(hue, value)])
rgb_colors = hsv_to_rgb(hsv_colors)

# Plot timeline (x-axis) with colors based on 1D PCA hue
fig, ax = plt.subplots(figsize=(12, 2))

for i, (x, color) in enumerate(zip(df['start_rel'], rgb_colors)):
    ax.scatter(
        x,
        0,
        color=color,
        alpha=0.6,
        edgecolors='none',
        s=50,
        marker='o'
    )

ax.set_yticks([])
ax.set_xlabel('Time (seconds, relative)')
ax.set_title('Diarizations colored by 1D PCA (Hue, Max Saturation)')
plt.tight_layout()
plt.show()

# %%

def apply_pca_color_transform(new_embeddings, pca_params):
    """
    Apply the fitted PCA and normalization to new embeddings.
    
    Args:
        new_embeddings: numpy array of shape (n_samples, embedding_dim)
        pca_params: dict with keys 'pca', 'pca_min', 'pca_range'
    
    Returns:
        hue: numpy array of shape (n_samples,) with values in [0, 1]
        rgb_colors: numpy array of shape (n_samples, 3) with RGB colors
    """
    pca = pca_params['pca']
    pca_min = pca_params['pca_min']
    pca_range = pca_params['pca_range']
    
    # Transform using fitted PCA (no fitting)
    X_pca = pca.transform(new_embeddings)
    
    # Normalize using same parameters
    hue = (X_pca - pca_min) / pca_range
    hue = np.clip(hue.flatten(), 0, 1)
    
    # Convert to RGB
    saturation = 1.0
    value = 1.0
    hsv_colors = np.column_stack([hue, np.full_like(hue, saturation), np.full_like(hue, value)])
    rgb_colors = hsv_to_rgb(hsv_colors)
    
    return hue, rgb_colors

# Example: Apply to new embeddings
# new_embeddings = np.stack([some_new_embedding])
# hue, rgb_colors = apply_pca_color_transform(new_embeddings, pca_params)

# %%

import torch

from speechbrain.inference.speaker import SpeakerRecognition

class SpeakerToEmbedding(SpeakerRecognition):
    def get_embedding(self, *files: str) -> np.ndarray:
        waveforms = [self.load_audio(file) for file in files]
        batch = torch.stack(waveforms)
        return self.encode_batch(batch).detach().numpy()

model = SpeakerToEmbedding.from_hparams(source="speechbrain/spkrec-ecapa-voxceleb", savedir="pretrained_models/spkrec-ecapa-voxceleb")


t1 = '67fed949573b7e8abb1c228f.local.wav' # noisy 
# t1 = '67fed6c7573b7e8abb1c2116.local.wav'
t2 = '67fed75a573b7e8abb1c213c.local.wav'

embeddings = model.get_embedding(t1, t2)
embeddings.shape

# %%
embeddings[0]
# %%


from speechbrain.inference.separation import SepformerSeparation as separator

model = separator.from_hparams(source="speechbrain/sepformer-whamr-enhancement", savedir='pretrained_models/sepformer-whamr-enhancement4')
enhanced_speech = model.separate_file(path='67fed949573b7e8abb1c228f.local.wav')
# %%
enhanced_speech
Audio(enhanced_speech[:, :].detach().cpu().squeeze(), rate=8000)
# %%
Audio(filename='67fed949573b7e8abb1c228f.local.wav')

# %%
