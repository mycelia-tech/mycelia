import math
import re

subtitle_credit_pattern = re.compile(r'^субтитры\s+с?делал\s+dimatorzok[.!?…]*$', re.IGNORECASE)
known_errors = {
    'Продолжение следует...',
    '.',
    '...',
    '*',
    'おやすみなさい。',
    '*sad breathing*',
    '*mimics*',
    '- Mm.',
    '- Oh.',
    '- Yeah.',
    'И...',
    'uh',
    'Ну...',
    '-',
    'Дякую за перегляд!',
    'oh',
}


asterisk_pattern = re.compile(r'^\*.*\*$')

remove_if_lonely = {
    'Thank you.',
    "I'm sorry.",
    'Okay.',
    'All right.',
    'Спасибо.',
    'Дякую.',
    'Gracias.',
    'Obrigado.',
    'Dziękuję.',
}


def clip_timestamps(item: dict, duration_seconds: float) -> dict | None:
    start, end = item.get("start"), item.get("end")
    if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (start, end)):
        return None
    if end < start or end <= 0 or start >= duration_seconds:
        return None
    if start >= 0 and end <= duration_seconds:
        return item
    return {**item, "start": max(0, start), "end": min(duration_seconds, end)}
