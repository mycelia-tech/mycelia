export const knownErrors = new Set([
  'Продолжение следует...',
  '.',
  '...',
  '*',
  'おやすみなさい。',
  '*sad breathing*',
  '*mimics*',
  '-',
  'Дякую за перегляд!',
]);

export const asteriskPattern = /^\*.*\*$/;

export function isSubtitleCreditArtifact(text: string): boolean {
  return /^субтитры\s+с?делал\s+dimatorzok[.!?…]*$/iu.test(text.trim());
}

const shortInterjections = new Set([
  '- Mm.',
  '- Oh.',
  '- Yeah.',
  'И...',
  'uh',
  'Ну...',
  'oh',
]);

export const removeIfLonely = new Set([
  'Thank you.',
  "I'm sorry.",
  'Okay.',
  'All right.',
  'Спасибо.',
  'Дякую.',
  'Gracias.',
  'Obrigado.',
  'Dziękuję.',
]);

function clipTimestamps(item: any, durationSeconds: number) {
  const { start, end } = item;
  if (
    !Number.isFinite(start) || !Number.isFinite(end) || end < start ||
    end <= 0 || start >= durationSeconds
  ) return null;
  if (start >= 0 && end <= durationSeconds) return item;
  return {
    ...item,
    start: Math.max(0, start),
    end: Math.min(durationSeconds, end),
  };
}

export function filterSegments(
  segments: any[],
  durationSeconds: number,
  whisperVadFilter = false,
) {
  const filtered = [];
  for (const segment of segments) {
    const text = segment.text?.trim();
    if (
      !text || knownErrors.has(text) || knownErrors.has(text.toLowerCase()) ||
      (!whisperVadFilter &&
        (shortInterjections.has(text) || shortInterjections.has(text.toLowerCase()))) ||
      asteriskPattern.test(text) || isSubtitleCreditArtifact(text)
    ) continue;
    const clipped = clipTimestamps(segment, durationSeconds);
    if (!clipped) continue;
    if (Array.isArray(clipped.words)) {
      filtered.push({
        ...clipped,
        words: clipped.words.map((word: any) =>
          clipTimestamps(word, durationSeconds)
        ).filter(Boolean),
      });
    } else {
      filtered.push(clipped);
    }
  }

  if (filtered.length === 0) return [];
  
  if (!whisperVadFilter && filtered.length === 1) {
    const text = filtered[0].text?.trim();
    if (removeIfLonely.has(text)) return [];
  }

  return filtered;
}




