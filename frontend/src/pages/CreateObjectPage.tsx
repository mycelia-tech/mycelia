import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { callResource } from "@/lib/api";
import type { Object, ObjectFormData } from "@/types/objects";
import { validateObjectForSave } from "@/types/objects";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ObjectForm } from "@/components/ObjectForm";
import { SmartBackButton } from "@/components/SmartBackButton";

const CreateObjectPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize from URL params if available
  const initialStart = searchParams.get("start")
    ? new Date(Number(searchParams.get("start")))
    : undefined;
  const initialEnd = searchParams.get("end")
    ? new Date(Number(searchParams.get("end")))
    : undefined;

  const [object, setObject] = useState<ObjectFormData>({
    name: "",
    details: "",
    icon: { text: "📦" },
    aliases: [],
    isPromise: false,
    isEvent: !!initialStart, // Auto-check "Is Event" if start time is provided
    timeRanges: initialStart
      ? [{ start: initialStart, end: initialEnd }]
      : [],
    createdAt: new Date(),
  });

  const handleUpdate = async (updates: Partial<ObjectFormData>) => {
    setObject((prev) => ({ ...prev, ...updates }));
    return Promise.resolve();
  };

  const handleSubmit = async () => {
    const validation = validateObjectForSave(object);
    if (!validation.valid) {
      setError(validation.error!);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await callResource("objects", {
        action: "create",
        object: {
          ...object,
          name: object.name?.trim(),
        },
      });

      if (result.insertedId) {
        navigate(`/objects/${result.insertedId}`);
      } else {
        throw new Error("Failed to create object");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create object");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <SmartBackButton defaultPath="/objects" label="Back to Objects" />
        <h1 className="text-3xl font-bold">Create Object</h1>
      </div>

      <Card className="p-6">
        <ObjectForm object={object} onUpdate={handleUpdate} />

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        <div className="flex gap-3 mt-6">
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !object.name?.trim()}
            className="flex-1"
          >
            {isSubmitting ? "Creating..." : "Create Object"}
          </Button>
          <Button
            variant="outline"
            onClick={() => navigate("/objects")}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default CreateObjectPage;
