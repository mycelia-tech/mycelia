import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

export function ChatResponseProgress({
  label,
  startedAt,
}: {
  label: string;
  startedAt?: number;
}) {
  const [mountedAt] = useState(Date.now);
  const [now, setNow] = useState(mountedAt);

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, []);

  const seconds = Math.max(
    0,
    Math.floor((now - (startedAt ?? mountedAt)) / 1000),
  );
  const elapsed = `${Math.floor(seconds / 60)}:${
    String(seconds % 60).padStart(2, "0")
  }`;

  return (
    <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
      <span
        className="flex min-w-0 items-center gap-2 font-medium"
        role="status"
      >
        <Loader2
          className="h-4 w-4 shrink-0 text-primary motion-safe:animate-spin"
          aria-hidden
        />
        {label}
      </span>
      <span
        className="shrink-0 font-mono tabular-nums text-muted-foreground"
        role="timer"
        aria-label="Elapsed response time"
      >
        {elapsed}
      </span>
    </div>
  );
}
