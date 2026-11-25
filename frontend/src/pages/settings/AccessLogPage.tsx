import { useEffect, useState } from "react";
import { callResource } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { FileSearch, RefreshCw } from "lucide-react";

interface AccessLogEntry {
  _id: string;
  principal: string;
  resource: string;
  actions: Array<{
    path: string[];
    actions: string[];
  }>;
  timestamp: Date;
}

const AccessLogPage = () => {
  const [logs, setLogs] = useState<AccessLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(100);
  const [principalFilter, setPrincipalFilter] = useState("");
  const [resourceFilter, setResourceFilter] = useState("");

  const fetchLogs = async () => {
    try {
      setLoading(true);
      setError(null);

      const query: any = {};
      if (principalFilter.trim()) {
        query.principal = principalFilter.trim();
      }
      if (resourceFilter.trim()) {
        query.resource = resourceFilter.trim();
      }

      const result = await callResource("mongo", {
        action: "find",
        collection: "access_logs",
        query,
        options: {
          sort: { timestamp: -1 },
          limit,
        },
      }) as any[];

      setLogs(result.map((log: any) => ({
        _id: log._id.toString(),
        principal: log.principal,
        resource: log.resource,
        actions: log.actions,
        timestamp: new Date(log.timestamp),
      })));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to fetch access logs",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [limit]);

  const handleRefresh = () => {
    fetchLogs();
  };

  const handleFilter = () => {
    fetchLogs();
  };

  if (loading && logs.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Access Log</h2>
          <p className="text-muted-foreground">
            View and audit access logs for security and compliance.
          </p>
        </div>
        <div className="border rounded-lg p-8 text-center">
          <p className="text-muted-foreground">Loading access logs...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Access Log</h2>
          <p className="text-muted-foreground">
            View and audit access logs for security and compliance.
          </p>
        </div>
        <Button onClick={handleRefresh} variant="outline">
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="border border-red-500 rounded-lg p-4 bg-red-50 dark:bg-red-950">
          <p className="text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      <Card className="p-6">
        <div className="space-y-4">
          <h3 className="font-semibold text-lg">Filters</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="principal">Principal</Label>
              <Input
                id="principal"
                value={principalFilter}
                onChange={(e) => setPrincipalFilter(e.target.value)}
                placeholder="Filter by principal..."
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleFilter();
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="resource">Resource</Label>
              <Input
                id="resource"
                value={resourceFilter}
                onChange={(e) => setResourceFilter(e.target.value)}
                placeholder="Filter by resource..."
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleFilter();
                  }
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="limit">Limit</Label>
              <Input
                id="limit"
                type="number"
                value={limit}
                onChange={(e) => setLimit(parseInt(e.target.value) || 100)}
                min={1}
                max={1000}
              />
            </div>
          </div>
          <Button onClick={handleFilter}>Apply Filters</Button>
        </div>
      </Card>

      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h3 className="text-lg font-semibold">
            Log Entries ({logs.length})
          </h3>
        </div>
        {logs.length === 0 ? (
          <Card className="p-8 text-center border-dashed">
            <FileSearch className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
            <p className="text-muted-foreground">
              No access logs found. Logs will appear here as resources are accessed.
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {logs.map((log) => (
              <Card key={log._id} className="p-4">
                <div className="space-y-3">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex items-center gap-3">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="break-all text-sm font-semibold">
                              {log.principal}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              →
                            </span>
                            <span className="break-all font-mono text-sm">
                              {log.resource}
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {log.timestamp.toLocaleString()}
                          </div>
                        </div>
                      </div>
                      <div className="space-y-1">
                        {log.actions.map((action, idx) => (
                          <div
                            key={idx}
                            className="mr-2 inline-block max-w-full break-all rounded bg-muted px-2 py-1 text-sm"
                          >
                            <span className="font-mono">
                              {action.path.join(".")}
                            </span>
                            <span className="mx-1">:</span>
                            <span>{action.actions.join(", ")}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AccessLogPage;


