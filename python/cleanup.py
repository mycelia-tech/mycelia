# %%
from datetime import datetime, timedelta

import pytz

from lib.resources import call_resource
from lib.transcription import known_errors, remove_if_lonely, subtitle_credit_pattern


# %%
end_date = datetime.now(pytz.UTC)
start_date = end_date - timedelta(days=3000)

    
pipeline = [
    {
        "$match": {
            "start": {
                "$gte": start_date,
                "$lt": end_date,
            }
        }
    },
    {
        "$addFields": {
            "cleanedSegments": {
                "$filter": {
                    "input": {"$ifNull": ["$segments", []]},
                    "as": "seg",
                    "cond": {
                        "$and": [
                            {
                                "$not": {
                                    "$in": [
                                        {"$trim": {"input": "$$seg.text"}},
                                        list(known_errors)
                                    ]
                                }
                            },
                            {
                                "$not": {
                                    "$regexMatch": {
                                        "input": {"$trim": {"input": "$$seg.text"}},
                                        "regex": subtitle_credit_pattern.pattern,
                                        "options": "i",
                                    }
                                }
                            },
                            {
                                "$not": {
                                    "$regexMatch": {
                                        "input": {"$trim": {"input": "$$seg.text"}},
                                        "regex": r"^\*.*\*$"
                                    }
                                }
                            }
                        ]
                    }
                }
            },
        },
    },
    {
        "$addFields": {
            "keepableSegments": {
                "$filter": {
                    "input": "$cleanedSegments",
                    "as": "seg",
                    "cond": {
                        "$not": {
                            "$in": [
                                {"$trim": {"input": "$$seg.text"}},
                                list(remove_if_lonely)
                            ]
                        }
                    }
                },
            },
        },
    },
    {
        "$addFields": {
            "keepableCount": {"$size": "$keepableSegments"},
            "originalSegmentCount": {"$size": {"$ifNull": ["$segments", []]}},
            "cleanedSegmentCount": {"$size": "$cleanedSegments"},
        },
    },
    {
        "$addFields": {
            "shouldDelete": {"$eq": ["$keepableCount", 0]},
        },
    },
    {
        "$addFields": {
            "needsUpdate": {
                "$and": [
                    {"$ne": [{"$size": {"$ifNull": ["$segments", []]}}, {"$size": "$cleanedSegments"}]},
                    {"shouldDelete": False}
                ]
            },
        }
    },
    {
        "$match": {
            "$or": [
                {"shouldDelete": {"$eq": True}},
                {"needsUpdate": {"$eq": True}}
            ]
        }
    },
    {
        "$project": {
            "_id": 1,
            "originalSegmentCount": 1,
            "cleanedSegmentCount": 1,
            "cleanedSegments": 1,
            "needsUpdate": 1,
            "shouldDelete": 1,
        }
    },
]

results = call_resource(
    "mongo",
    {
        "action": "aggregate",
        "collection": "transcriptions",
        "pipeline": pipeline,
    }
)

len(results)


#%%
#%%
from collections import Counter

def get_verdict(result: dict) -> str:
    if result["shouldDelete"]:
        return "delete"
    elif not result.get("needsUpdate", True):
        return "no action"

    return "update"

counter = Counter(get_verdict(result) for result in results)
counter.most_common()

#%%



bulk_operations = []
deleted_count = 0
updated_count = 0
total_segments_removed = 0

for result in results:
    segments_removed = (
        result["originalSegmentCount"] - result["cleanedSegmentCount"] 
        if result["needsUpdate"] else 
        result["originalSegmentCount"] 
    )
    total_segments_removed += segments_removed
    
    if result["shouldDelete"]:
        bulk_operations.append({
            "deleteOne": {
                "filter": {"_id": result["_id"]}
            }
        })
        deleted_count += 1
    else:
        bulk_operations.append({
            "updateOne": {
                "filter": {"_id": result["_id"]},
                "update": {"$set": {"segments": result["cleanedSegments"]}}
            }
        })
        updated_count += 1
#%%
print(f"  Total transcripts processed: {len(bulk_operations)}")
print(f"  Deleted transcripts: {deleted_count}")
print(f"  Updated transcripts: {updated_count}")
print(f"  Total segments removed: {total_segments_removed}")
#%%

if bulk_operations:
    call_resource(
        "mongo",
        {
            "action": "bulkWrite",
            "collection": "transcriptions",
            "operations": bulk_operations,
            "options": {"ordered": False}
        }
    )


#%%

# %%
