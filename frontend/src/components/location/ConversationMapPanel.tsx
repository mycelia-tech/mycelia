import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useConversationMapClusterGroups,
  useConversationMapGroupItems,
} from "@/hooks/useLocationQueries";
import type {
  ConversationMapCluster,
  ConversationMapGroupSummary,
} from "@/types/location";
import { formatPlace } from "@/types/location";

function iconText(icon: unknown): string {
  if (typeof icon === "string") return icon;
  if (icon && typeof icon === "object" && "text" in icon) {
    return String((icon as { text?: unknown }).text ?? "");
  }
  return "";
}

export function ConversationMapPanel({
  cluster,
  start,
  end,
  revision,
  onClose,
  onFlyTo,
}: {
  cluster: ConversationMapCluster;
  start: Date;
  end: Date;
  revision: number;
  onClose: () => void;
  onFlyTo: (target: [number, number]) => void;
}) {
  const [selectedGroup, setSelectedGroup] = useState<
    ConversationMapGroupSummary | null
  >(null);
  const [groupCursors, setGroupCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  const [itemCursors, setItemCursors] = useState<Array<string | undefined>>([
    undefined,
  ]);
  useEffect(() => {
    setSelectedGroup(
      cluster.singleGroupKey
        ? {
          groupKey: cluster.singleGroupKey,
          conversationCount: cluster.conversationCount,
          loc: { type: "Point", coordinates: cluster.center },
          place: null,
        }
        : null,
    );
    setGroupCursors([undefined]);
    setItemCursors([undefined]);
  }, [cluster.id]);
  const groupCursor = groupCursors.at(-1);
  const itemCursor = itemCursors.at(-1);
  const groups = useConversationMapClusterGroups(
    start,
    end,
    cluster.cell,
    revision,
    groupCursor,
  );
  const items = useConversationMapGroupItems(
    start,
    end,
    selectedGroup?.groupKey,
    revision,
    itemCursor,
  );
  const projectionChanged = groups.data?.error === "projection_changed" ||
    items.data?.error === "projection_changed";

  return (
    <Card className="z-[1001] flex w-80 max-w-full shrink-0 flex-col overflow-hidden max-md:absolute max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[65%] max-md:w-full">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div className="flex min-w-0 items-center gap-1">
          {selectedGroup && !cluster.singleGroupKey && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => {
                setSelectedGroup(null);
                setItemCursors([undefined]);
              }}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <CardTitle className="truncate text-base">
            {selectedGroup
              ? formatPlace(selectedGroup.place)
              : `${cluster.conversationCount} conversations`}
          </CardTitle>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {projectionChanged && (
          <p className="rounded bg-amber-500/10 p-2 text-xs text-amber-700">
            The map index changed. Close and reopen this cluster to refresh it.
          </p>
        )}
        {!selectedGroup && groups.isLoading && (
          <p className="text-sm text-muted-foreground">Loading groups…</p>
        )}
        {!selectedGroup && groups.data?.items.map((group) => (
          <button
            type="button"
            key={group.groupKey}
            className="w-full rounded-md border p-2 text-left text-sm hover:bg-accent"
            onClick={() => {
              setSelectedGroup(group);
              setItemCursors([undefined]);
            }}
          >
            <span className="block font-medium">
              {formatPlace(group.place)}
            </span>
            <span className="text-xs text-muted-foreground">
              {group.conversationCount} conversations
            </span>
          </button>
        ))}
        {selectedGroup && items.isLoading && (
          <p className="text-sm text-muted-foreground">
            Loading conversations…
          </p>
        )}
        {selectedGroup &&
          items.data?.items.map((item) => (
            <div
              key={String(item.conversationId)}
              className="rounded-md border p-2 text-sm"
            >
              <Link
                to={`/objects/${item.conversationId}`}
                className="font-medium hover:underline"
              >
                {iconText(item.icon) ? `${iconText(item.icon)} ` : ""}
                {item.name || "Untitled conversation"}
              </Link>
              <button
                type="button"
                className="mt-1 block text-xs text-muted-foreground hover:text-foreground"
                onClick={() =>
                  onFlyTo([
                    item.loc.coordinates[1],
                    item.loc.coordinates[0],
                  ])}
              >
                {new Date(item.start).toLocaleString()} · {item.matchKind}
              </button>
            </div>
          ))}
      </CardContent>
      <div className="flex items-center justify-between border-t p-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={(selectedGroup ? itemCursors : groupCursors).length <= 1}
          onClick={() =>
            selectedGroup
              ? setItemCursors((values) => values.slice(0, -1))
              : setGroupCursors((values) => values.slice(0, -1))}
        >
          <ChevronLeft className="mr-1 h-4 w-4" /> Previous
        </Button>
        <span className="text-xs text-muted-foreground">
          {selectedGroup ? items.data?.total ?? 0 : groups.data?.total ?? 0}
          {" "}
          total
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!(selectedGroup
            ? items.data?.nextCursor
            : groups.data?.nextCursor)}
          onClick={() => {
            const cursor = selectedGroup
              ? items.data?.nextCursor
              : groups.data?.nextCursor;
            if (!cursor) return;
            selectedGroup
              ? setItemCursors((values) => [...values, cursor])
              : setGroupCursors((values) => [...values, cursor]);
          }}
        >
          Next <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}
