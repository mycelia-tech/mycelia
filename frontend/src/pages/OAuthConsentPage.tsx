import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AlertCircle, Shield } from "lucide-react";
import { ApiClient } from "@/lib/api";

interface ConsentDetails {
  client_id: string;
  client_name: string;
  scope: string;
  redirect_uri: string;
}

const defaultScopeYaml = `- resource: "*"
  action: "*"
  effect: allow`;

const OAuthConsentPage = () => {
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get("request_id");

  const [details, setDetails] = useState<ConsentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [scopeYaml, setScopeYaml] = useState<string>(defaultScopeYaml);

  useEffect(() => {
    if (!requestId) {
      setError("Missing request_id parameter");
      setLoading(false);
      return;
    }

    const fetchDetails = async () => {
      try {
        const apiClient = new ApiClient();
        const response = await apiClient.get<ConsentDetails>(
          `/oauth/consent/details?request_id=${requestId}`
        );
        setDetails(response);
        setScopeYaml(response.scope === "*" ? defaultScopeYaml : response.scope);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load consent request");
      } finally {
        setLoading(false);
      }
    };

    fetchDetails();
  }, [requestId]);

  const handleConsent = async (approved: boolean) => {
    if (!requestId) return;

    setSubmitting(true);
    try {
      const apiClient = new ApiClient();
      const response = await apiClient.post<{ redirect_uri: string }>(
        "/oauth/consent",
        {
          request_id: requestId,
          approved,
          scope: approved ? scopeYaml : undefined,
        }
      );

      window.location.href = response.redirect_uri;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to process consent");
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading consent request...</p>
        </div>
      </div>
    );
  }

  if (error || !details) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-md w-full p-6 border rounded-lg bg-destructive/10 border-destructive">
          <div className="flex items-center gap-3 mb-4">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <h1 className="text-xl font-semibold text-destructive">Error</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {error || "Consent request not found"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-lg w-full space-y-4">
        <div className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
            <Shield className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-2xl font-bold">Authorization Request</h1>
          <p className="text-muted-foreground">
            An application is requesting access to your Mycelia account
          </p>
        </div>

        <div className="p-4 sm:p-5 border rounded-xl space-y-4 bg-card">
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-1">Application</h2>
            <p className="break-words text-lg font-semibold">{details.client_name}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="scope">Permissions (YAML)</Label>
            <textarea
              id="scope"
              value={scopeYaml}
              onChange={(e) => setScopeYaml(e.target.value)}
              className="flex min-h-36 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={defaultScopeYaml}
            />
            <p className="text-xs text-muted-foreground">
              Edit the access policies in YAML format before authorizing.
            </p>
          </div>

          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-1">Redirect URI</h2>
            <p className="text-sm font-mono text-muted-foreground break-all">{details.redirect_uri}</p>
          </div>
        </div>

        <div className="p-4 border rounded-lg bg-muted/50">
          <p className="text-sm text-muted-foreground">
            By authorizing, this application will be able to access your Mycelia data according to the requested permissions.
          </p>
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => handleConsent(false)}
            disabled={submitting}
          >
            Deny
          </Button>
          <Button
            className="flex-1"
            onClick={() => handleConsent(true)}
            disabled={submitting}
          >
            {submitting ? "Processing..." : "Authorize"}
          </Button>
        </div>

        <p className="text-xs text-center text-muted-foreground">
          This request will expire in 5 minutes
        </p>
      </div>
    </div>
  );
};

export default OAuthConsentPage;
