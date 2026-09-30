export function snapAudioRange(
  next: [number, number],
  domain: [number, number],
  available: Array<{ start: number; end: number }>,
  step: number,
  previous?: [number, number],
): [number, number] {
  const [domainStart, domainEnd] = domain;
  const minimumDuration = Math.min(step, domainEnd - domainStart);
  const preserveStart = previous != null && next[0] === previous[0];
  const preserveEnd = previous != null && next[1] === previous[1];
  const clamp = (timestamp: number) =>
    Math.min(domainEnd, Math.max(domainStart, timestamp));
  let start = clamp(next[0]);
  let end = clamp(next[1]);

  if (end - start < minimumDuration) {
    if (preserveEnd && !preserveStart) {
      start = Math.max(domainStart, end - minimumDuration);
    } else if (preserveStart && !preserveEnd) {
      end = Math.min(domainEnd, start + minimumDuration);
    } else if (!preserveStart && !preserveEnd) {
      end = Math.min(domainEnd, start + minimumDuration);
      start = end - minimumDuration;
    }
  }

  const intervals = available.filter((item) =>
    item.end > item.start && item.start < domainEnd && item.end > domainStart
  ).map((item) => ({
    start: clamp(item.start),
    end: clamp(item.end),
  }));
  const nearest = (timestamp: number, candidates: number[]) =>
    candidates.length === 0
      ? timestamp
      : candidates.reduce((best, candidate) =>
        Math.abs(candidate - timestamp) < Math.abs(best - timestamp)
          ? candidate
          : best
      );
  const snappedStart = preserveStart
    ? start
    : nearest(start, intervals.map((item) => item.start));
  const snappedEnd = preserveEnd
    ? end
    : nearest(end, intervals.map((item) => item.end));

  return snappedEnd - snappedStart >= minimumDuration
    ? [snappedStart, snappedEnd]
    : [start, end];
}
