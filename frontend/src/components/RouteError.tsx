import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function RouteError() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
    ? error.message
    : "An unexpected error occurred.";
  return (
    <main className="mx-auto max-w-xl space-y-4 p-6" role="alert">
      <h1 className="text-2xl font-semibold">This page could not be loaded</h1>
      <p>Reload the page to try again, or return to the home page.</p>
      <div className="flex gap-3">
        <Button onClick={() => window.location.reload()}>Reload page</Button>
        <Link className="rounded border px-4 py-2" to="/">Go home</Link>
      </div>
      <details>
        <summary className="cursor-pointer">Technical details</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words text-sm">{detail}</pre>
      </details>
    </main>
  );
}

export function PageLoading() {
  return (
    <div role="status" className="p-6 text-muted-foreground">Loading page…</div>
  );
}
