import { Button } from "@/components/ui/button";

export function RequestError(
  { title, message, onRetry, pending = false }: {
    title: string;
    message: string;
    onRetry: () => void;
    pending?: boolean;
  },
) {
  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm"
    >
      <p className="font-medium">{title}</p>
      <p className="break-words text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" disabled={pending} onClick={onRetry}>
        {pending ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
