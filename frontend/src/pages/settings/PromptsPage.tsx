import { useEffect, useState } from "react";
import { callResource } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Loader2, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { z } from "zod";
import { zPrompt, zServerConfig } from "@myceliasdk/config.ts";
import { toast } from "sonner";

const SERVER_CONFIG_ID = "000000000000000000000000";

type Prompt = z.infer<typeof zPrompt>;

const PromptsPage = () => {
  const [loading, setLoading] = useState(true);
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [defaultPromptId, setDefaultPromptId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Edit/Create dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null);
  const [formName, setFormName] = useState("");
  const [formText, setFormText] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [saving, setSaving] = useState(false);

  // Delete confirmation state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [promptToDelete, setPromptToDelete] = useState<Prompt | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchData = async () => {
    try {
      setLoading(true);
      const [promptsData, configData] = await Promise.all([
        callResource("mongo", {
          action: "find",
          collection: "prompts",
          query: {},
          options: { sort: { name: 1 } },
        }),
        callResource("mongo", {
          action: "findOne",
          collection: "configs",
          query: { _id: { $oid: SERVER_CONFIG_ID } },
        }),
      ]);

      const parsedPrompts = z.array(zPrompt).parse(promptsData);
      setPrompts(parsedPrompts);

      if (configData) {
        const config = zServerConfig.parse(configData);
        setDefaultPromptId(
          config.prompts?.summarization_system?.toString() || null,
        );
      }
    } catch (err) {
      console.error("Failed to fetch prompts:", err);
      setError(err instanceof Error ? err.message : "Failed to fetch prompts");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const openCreateDialog = () => {
    setEditingPrompt(null);
    setFormName("");
    setFormText("");
    setFormDescription("");
    setDialogOpen(true);
  };

  const openEditDialog = (prompt: Prompt) => {
    setEditingPrompt(prompt);
    setFormName(prompt.name);
    setFormText(prompt.text);
    setFormDescription(prompt.description || "");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formText.trim()) {
      toast.error("Name and text are required");
      return;
    }

    setSaving(true);
    try {
      if (editingPrompt) {
        // Update existing prompt
        await callResource("mongo", {
          action: "updateOne",
          collection: "prompts",
          query: { _id: { $oid: editingPrompt._id.toString() } },
          update: {
            $set: {
              name: formName.trim(),
              text: formText.trim(),
              description: formDescription.trim() || undefined,
            },
          },
        });
        toast.success("Prompt updated");
      } else {
        // Create new prompt
        await callResource("mongo", {
          action: "insertOne",
          collection: "prompts",
          document: {
            name: formName.trim(),
            text: formText.trim(),
            description: formDescription.trim() || undefined,
          },
        });
        toast.success("Prompt created");
      }
      setDialogOpen(false);
      fetchData();
    } catch (err) {
      console.error("Failed to save prompt:", err);
      toast.error("Failed to save prompt");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!promptToDelete) return;

    setDeleting(true);
    try {
      await callResource("mongo", {
        action: "deleteOne",
        collection: "prompts",
        query: { _id: { $oid: promptToDelete._id.toString() } },
      });
      toast.success("Prompt deleted");
      setDeleteDialogOpen(false);
      setPromptToDelete(null);
      fetchData();
    } catch (err) {
      console.error("Failed to delete prompt:", err);
      toast.error("Failed to delete prompt");
    } finally {
      setDeleting(false);
    }
  };

  const handleSetDefault = async (prompt: Prompt) => {
    try {
      await callResource("mongo", {
        action: "updateOne",
        collection: "configs",
        query: { _id: { $oid: SERVER_CONFIG_ID } },
        update: {
          $set: {
            "prompts.summarization_system": { $oid: prompt._id.toString() },
          },
        },
        options: { upsert: true },
      });
      setDefaultPromptId(prompt._id.toString());
      toast.success(`"${prompt.name}" set as default summarization prompt`);
    } catch (err) {
      console.error("Failed to set default prompt:", err);
      toast.error("Failed to set default prompt");
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Prompts</h2>
          <p className="text-muted-foreground">
            Prompt templates contain instructions only. Summary models are
            configured separately in Inference settings.
          </p>
        </div>
        <div className="border rounded-lg p-8 text-center">
          <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
          <p className="text-muted-foreground">Loading prompts...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Prompts</h2>
          <p className="text-muted-foreground">
            Prompt templates contain instructions only. Summary models are
            configured separately in Inference settings.
          </p>
        </div>
        <div className="border rounded-lg p-8 text-center">
          <p className="text-red-500">Error: {error}</p>
          <Button variant="outline" className="mt-4" onClick={fetchData}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Prompts</h2>
          <p className="text-muted-foreground">
            Prompt templates contain instructions only. Summary models are
            configured separately in Inference settings.
          </p>
        </div>
        <Button onClick={openCreateDialog}>
          <Plus className="w-4 h-4 mr-2" />
          New Prompt
        </Button>
      </div>

      {prompts.length === 0
        ? (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground mb-4">No prompts found</p>
            <Button onClick={openCreateDialog}>
              <Plus className="w-4 h-4 mr-2" />
              Create your first prompt
            </Button>
          </Card>
        )
        : (
          <div className="space-y-3">
            {prompts.map((prompt) => {
              const isDefault = prompt._id.toString() === defaultPromptId;
              return (
                <Card key={prompt._id.toString()} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-medium">{prompt.name}</h3>
                        {isDefault && (
                          <Badge variant="secondary" className="text-xs">
                            <Star className="w-3 h-3 mr-1 fill-current" />
                            Default prompt
                          </Badge>
                        )}
                        {isDefault && (
                          <Badge variant="outline" className="text-xs">
                            Model: Summaries route
                          </Badge>
                        )}
                      </div>
                      {prompt.description && (
                        <p className="text-sm text-muted-foreground mb-2">
                          {prompt.description}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground font-mono line-clamp-2">
                        {prompt.text}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {!isDefault && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleSetDefault(prompt)}
                          title="Set as default"
                        >
                          <Star className="w-4 h-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEditDialog(prompt)}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setPromptToDelete(prompt);
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>
              {editingPrompt ? "Edit Prompt" : "Create Prompt"}
            </DialogTitle>
            <DialogDescription>
              {editingPrompt
                ? "Update the prompt template details."
                : "Create a new prompt template for summarization."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g., 2-3 Paragraph Summary"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Input
                id="description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="Brief description of what this prompt does"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="text">Prompt Text</Label>
              <Textarea
                id="text"
                value={formText}
                onChange={(e) => setFormText(e.target.value)}
                placeholder="You are a helpful assistant..."
                className="min-h-[200px] font-mono text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {editingPrompt ? "Save Changes" : "Create Prompt"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Delete Prompt</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{promptToDelete?.name}"? This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PromptsPage;
