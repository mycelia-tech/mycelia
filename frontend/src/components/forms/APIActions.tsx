import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  Key,
  Loader2,
  Save,
  Trash2,
  XCircle,
} from "lucide-react";

interface APIActionsProps {
  hasChanges: boolean;
  isSaved: boolean;
  isExchanging: boolean;
  exchangeResult: "success" | string | null;
  canTest: boolean;
  onSave: () => void;
  onTestToken: () => void;
  onClear: () => void;
}

export function APIActions({
  hasChanges,
  isSaved,
  isExchanging,
  exchangeResult,
  canTest,
  onSave,
  onTestToken,
  onClear,
}: APIActionsProps) {
  const getErrorMessage = (error: string) => {
    if (error === "error" || error === "Token invalid") return "Token invalid";
    if (error.includes("Failed to fetch") || error.includes("Load failed") || error.includes("NetworkError")) {
      return "Server unreachable";
    }
    return error;
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-4">
      <Button
        onClick={onSave}
        disabled={!hasChanges || isSaved}
      >
        {isSaved
          ? (
            <>
              <CheckCircle2 className="w-4 h-4 mr-2" />
              Saved
            </>
          )
          : (
            <>
              <Save className="w-4 h-4 mr-2" />
              Save Settings
            </>
          )}
      </Button>

      <Button
        variant="outline"
        onClick={onTestToken}
        disabled={isExchanging || !canTest}
      >
        {isExchanging
          ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Exchanging...
            </>
          )
          : (
            <>
              <Key className="w-4 h-4 mr-2" />
              Test Token
            </>
          )}
      </Button>

      {exchangeResult && (
        <div role="status" className="order-last flex w-full min-w-0 items-center gap-2 break-words text-sm">
          {exchangeResult === "success"
            ? (
              <>
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                <span className="text-sm text-green-600">Token valid</span>
              </>
            )
            : (
              <>
                <XCircle className="w-5 h-5 text-red-600" />
                <span className="text-sm text-red-600">
                  {getErrorMessage(exchangeResult)}
                </span>
              </>
            )}
        </div>
      )}

      <Button
        variant="outline"
        className="@lg/settings:ml-auto"
        onClick={onClear}
        title="Sign out of this browser"
      >
        Log Out
      </Button>
    </div>
  );
}
