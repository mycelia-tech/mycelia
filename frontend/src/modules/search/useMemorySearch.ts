import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSettingsStore } from "@/stores/settingsStore";
import type { DateRangeValue } from "@/lib/datePicker";
import {
  ragApi,
  ragErrorMessage,
  type RagExactSource,
  type RagSearchMode,
} from "@/lib/rag";

export interface SearchForm {
  query: string;
  mode: RagSearchMode;
  kinds: string[];
  range?: DateRangeValue;
  limit: string;
  platforms: string;
  senderIds: string;
  sourceCollection: RagExactSource["collection"];
  sourceId: string;
  maxPerSource: string;
}
const kinds = [
  "transcription",
  "message",
  "object",
  "media_visual_description",
];
const collections = [
  "transcriptions",
  "messages",
  "objects",
  "media_visual_descriptions",
];
export const exactValues = (
  value: string,
) => [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
function date(value: string | null) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}
function choice(value: string | null, values: string[], fallback: string) {
  return value && values.includes(value) ? value : fallback;
}
export function readSearchForm(params: URLSearchParams): SearchForm {
  const start = date(params.get("start")), end = date(params.get("end"));
  return {
    query: params.get("q") ?? "",
    mode: choice(
      params.get("mode"),
      ["hybrid", "semantic", "lexical"],
      "hybrid",
    ) as RagSearchMode,
    kinds: exactValues(params.get("kinds") ?? "").filter((kind) =>
      kinds.includes(kind)
    ),
    range: start
      ? { start, end: end && end >= start ? end : undefined }
      : undefined,
    limit: choice(params.get("limit"), ["5", "10", "20", "50"], "10"),
    platforms: params.get("platforms") ?? "",
    senderIds: params.get("senders") ?? "",
    sourceCollection: choice(
      params.get("collection"),
      collections,
      "messages",
    ) as RagExactSource["collection"],
    sourceId: params.get("source") ?? "",
    maxPerSource: choice(
      params.get("perSource"),
      ["1", "2", "3", "5", "10"],
      "2",
    ),
  };
}
export function searchFormParams(form: SearchForm) {
  const params = new URLSearchParams();
  params.set("q", form.query.trim());
  params.set("mode", form.mode);
  if (form.kinds.length) params.set("kinds", form.kinds.join(","));
  if (form.range) {
    params.set("start", form.range.start.toISOString());
    if (form.range.end) params.set("end", form.range.end.toISOString());
  }
  params.set("limit", form.limit);
  params.set("perSource", form.maxPerSource);
  if (form.platforms.trim()) {
    params.set("platforms", exactValues(form.platforms).join(","));
  }
  if (form.senderIds.trim()) {
    params.set("senders", exactValues(form.senderIds).join(","));
  }
  if (form.sourceId.trim()) {
    params.set("collection", form.sourceCollection);
    params.set("source", form.sourceId.trim());
  }
  return params;
}

export function useMemorySearch() {
  const [params, setParams] = useSearchParams();
  const serialized = params.toString();
  const submitted = readSearchForm(params);
  const [form, setForm] = useState(() => submitted);
  const [validationError, setValidationError] = useState<string | null>(null);
  const endpoint = useSettingsStore((state) => state.apiEndpoint);
  const client = useQueryClient();
  const scroll = useRef(0);
  const key = searchFormParams(submitted).toString();
  useEffect(() => {
    setForm(readSearchForm(new URLSearchParams(serialized)));
    setValidationError(null);
  }, [serialized]);
  const search = useQuery({
    queryKey: ["memory-search", endpoint, key],
    enabled: Boolean(submitted.query.trim()),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
    retry: false,
    queryFn: ({ signal }) =>
      ragApi.search({
        query: submitted.query.trim(),
        mode: submitted.mode,
        kinds: submitted.kinds,
        start: submitted.range?.start.toISOString(),
        end: submitted.range?.end?.toISOString(),
        limit: Number(submitted.limit),
        platforms: exactValues(submitted.platforms),
        senderIds: exactValues(submitted.senderIds),
        sources: submitted.sourceId.trim()
          ? [{
            collection: submitted.sourceCollection,
            id: submitted.sourceId.trim(),
          }]
          : undefined,
        maxPerSource: Number(submitted.maxPerSource),
      }, signal),
  });
  const ready = Boolean(search.data);
  useEffect(() => {
    if (!ready) return;
    const positionKey = ["memory-search-position", endpoint, key];
    scroll.current = client.getQueryData<number>(positionKey) ?? 0;
    const frame = requestAnimationFrame(() =>
      window.scrollTo({ top: scroll.current, behavior: "instant" })
    );
    const remember = () => {
      scroll.current = window.scrollY;
    };
    globalThis.addEventListener("scroll", remember, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      globalThis.removeEventListener("scroll", remember);
      client.setQueryData(positionKey, scroll.current);
    };
  }, [client, endpoint, key, ready]);
  function setField<K extends keyof SearchForm>(
    field: K,
    value: SearchForm[K],
  ) {
    setForm((current) => ({ ...current, [field]: value }));
  }
  function submit() {
    if (!form.query.trim()) {
      setValidationError("Enter a question or phrase to search your memories.");
      return;
    }
    setValidationError(null);
    const next = searchFormParams(form);
    if (next.toString() === key && submitted.query.trim()) {
      void search.refetch();
    } else setParams(next);
  }
  return {
    form,
    setField,
    submit,
    response: search.data,
    loading: search.isFetching,
    error: validationError ??
      (search.error ? ragErrorMessage(search.error) : null),
    hasSearched: Boolean(submitted.query.trim()),
  };
}
