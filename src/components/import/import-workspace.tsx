"use client";

import { FileUp, RotateCcw, Trash2, UploadCloud } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { t, tOptional } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Mirrors the API item DTO fields the UI needs (docs/API_CONTRACT.md §4). */
interface ServerItem {
  id: string;
  clientKey: string | null;
  filename: string;
  status: string;
  outcome: string | null;
  resultArtifactId: string | null;
  resultArtifactTitle: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  warnings: string[];
}

interface Entry {
  /** Client-side de-duplication key (name, size, mtime). */
  key: string;
  /** Short idempotency key sent to the server (long file names must not overflow it). */
  clientKey: string;
  file: File;
  progress: number;
  /** Client-side phase; once the server knows the item, its status takes over. */
  phase: "pending" | "uploading" | "uploaded" | "uploadError";
  error?: string;
  itemId?: string;
}

const ACTIVE_SERVER_STATUSES = new Set(["awaiting_upload", "uploaded", "queued", "processing"]);
const MAX_PARALLEL_UPLOADS = 3;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!response.ok) throw new Error(json.error?.message ?? `HTTP ${response.status}`);
  return json as T;
}

function putWithProgress(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (percent: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(file);
  });
}

const entryKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;
const newClientKey = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function ImportWorkspace({
  maxFileBytes,
  allowedExtensions,
}: {
  maxFileBytes: number;
  allowedExtensions: string[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [items, setItems] = useState<Map<string, ServerItem>>(new Map());
  const [running, setRunning] = useState(false);
  const [autoVersion, setAutoVersion] = useState(true);
  const [platform, setPlatform] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Poll numbering: a retry discards reports requested before it (they predate the retry). */
  const pollSeq = useRef(0);
  const acceptAfterSeq = useRef(0);

  const update = useCallback((key: string, patch: Partial<Entry>) => {
    setEntries((current) =>
      current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    );
  }, []);

  function addFiles(list: FileList | File[]) {
    const accepted: Entry[] = [];
    const refused: string[] = [];
    for (const file of Array.from(list)) {
      if (!allowedExtensions.includes(extensionOf(file.name)))
        refused.push(`${file.name}：${t("import.unsupported")}`);
      else if (file.size > maxFileBytes) refused.push(`${file.name}：${t("import.tooLarge")}`);
      else if (file.size > 0)
        accepted.push({
          key: entryKey(file),
          clientKey: newClientKey(),
          file,
          progress: 0,
          phase: "pending",
        });
    }
    setRejected(refused);
    setEntries((current) => [
      ...current,
      ...accepted.filter((entry) => !current.some((existing) => existing.key === entry.key)),
    ]);
  }

  async function uploadOne(batch: string, entry: Entry) {
    update(entry.key, { phase: "uploading", progress: 0, error: undefined });
    try {
      const declared = await api<{
        item: ServerItem;
        upload: { url: string; headers: Record<string, string> } | null;
      }>(`/api/imports/${batch}/items`, {
        filename: entry.file.name,
        size: entry.file.size,
        clientKey: entry.clientKey,
        mimeType: entry.file.type || undefined,
      });
      update(entry.key, { itemId: declared.item.id });
      if (declared.upload) {
        await putWithProgress(
          declared.upload.url,
          declared.upload.headers,
          entry.file,
          (progress) => update(entry.key, { progress }),
        );
      }
      await api(`/api/imports/${batch}/items/${declared.item.id}/complete`, {});
      update(entry.key, { phase: "uploaded", progress: 100 });
    } catch (uploadError) {
      update(entry.key, {
        phase: "uploadError",
        error: uploadError instanceof Error ? uploadError.message : String(uploadError),
      });
    }
  }

  async function start() {
    setError(null);
    setRunning(true);
    try {
      let batch = batchId;
      if (!batch) {
        const created = await api<{ batch: { id: string } }>("/api/imports", {
          options: {
            autoVersionByFilename: autoVersion,
            ...(platform ? { sourcePlatform: platform } : {}),
          },
        });
        batch = created.batch.id;
        setBatchId(batch);
      }
      const queue = entries.filter(
        (entry) => entry.phase === "pending" || entry.phase === "uploadError",
      );
      const workers = Array.from(
        { length: Math.min(MAX_PARALLEL_UPLOADS, queue.length) },
        async () => {
          for (let next = queue.shift(); next; next = queue.shift()) await uploadOne(batch!, next);
        },
      );
      await Promise.all(workers);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setRunning(false);
    }
  }

  async function retryServerItem(itemId: string) {
    if (!batchId) return;
    try {
      await api(`/api/imports/${batchId}/items/${itemId}/retry`, {});
      acceptAfterSeq.current = pollSeq.current;
      setItems((current) =>
        new Map(current).set(itemId, {
          ...current.get(itemId)!,
          status: "queued",
          errorCode: null,
          errorMessage: null,
        }),
      );
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError));
    }
  }

  const rows = entries.map((entry) => ({
    entry,
    item: entry.itemId ? items.get(entry.itemId) : undefined,
  }));
  // While uploading, and after a client-side upload failure, the client phase wins as long as
  // the server still says awaiting_upload; once the server has moved on (e.g. /complete
  // committed but its response was lost) the server's status is the truth.
  const statusOf = ({ entry, item }: (typeof rows)[number]) =>
    (entry.phase === "uploadError" || entry.phase === "uploading") &&
    (!item || item.status === "awaiting_upload")
      ? entry.phase
      : (item?.status ?? entry.phase);

  // Poll while any started upload has no terminal server state yet, including items the
  // server has not reported at all (a fresh item in a re-used batch) and retried items.
  const pending = rows.some((row) => {
    const status = statusOf(row);
    return (
      status === "uploading" ||
      status === "uploaded" ||
      (row.item !== undefined && ACTIVE_SERVER_STATUSES.has(status))
    );
  });
  useEffect(() => {
    if (!batchId || !pending) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return; // a slow report is never superseded by its own successors
      inFlight = true;
      const seq = ++pollSeq.current;
      try {
        const report = await api<{ items: ServerItem[] }>(`/api/imports/${batchId}`);
        if (cancelled || seq <= acceptAfterSeq.current) return;
        setItems(new Map(report.items.map((item) => [item.id, item])));
        if (!report.items.some((item) => ACTIVE_SERVER_STATUSES.has(item.status))) router.refresh();
      } catch {
        /* transient polling failure: the next tick retries */
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [batchId, pending, router]);

  const counts = { succeeded: 0, duplicate: 0, failed: 0, pending: 0 };
  for (const row of rows) {
    const status = statusOf(row);
    if (status === "succeeded") counts.succeeded += 1;
    else if (status === "duplicate") counts.duplicate += 1;
    else if (
      status === "failed" ||
      status === "uploadError" ||
      status === "expired" ||
      status === "cancelled"
    )
      counts.failed += 1;
    else counts.pending += 1;
  }
  const canStart =
    !running && entries.some((entry) => entry.phase === "pending" || entry.phase === "uploadError");

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
  }

  return (
    <div className="flex flex-col gap-5">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          dragging ? "border-primary bg-accent" : "border-border-strong bg-surface",
        )}
      >
        <UploadCloud aria-hidden className="text-muted-foreground size-9" />
        <p className="text-sm">
          {t("import.drop")}{" "}
          <button
            type="button"
            className="text-primary font-medium underline-offset-4 hover:underline"
            onClick={() => inputRef.current?.click()}
          >
            {t("import.choose")}
          </button>
        </p>
        <p className="text-muted-foreground text-xs">
          {t("import.accepted", { size: formatBytes(maxFileBytes) })}
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          data-testid="import-file-input"
          accept={allowedExtensions.map((extension) => `.${extension}`).join(",")}
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {rejected.length > 0 ? (
        <ul role="alert" className="text-danger flex flex-col gap-1 text-sm">
          {rejected.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      <div className="border-border bg-surface flex flex-col gap-3 rounded-lg border p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoVersion}
            disabled={batchId !== null}
            onChange={(event) => setAutoVersion(event.target.checked)}
          />
          <span>{t("import.options.autoVersion")}</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("import.options.platform")}</span>
          <select
            value={platform}
            disabled={batchId !== null}
            onChange={(event) => setPlatform(event.target.value)}
            className="border-border-strong bg-surface h-8 rounded-md border px-2"
          >
            <option value="">{t("import.options.platformNone")}</option>
            {["claude_design", "claude", "chatgpt", "gemini", "other"].map((value) => (
              <option key={value} value={value}>
                {tOptional(`platform.${value}`) ?? value}
              </option>
            ))}
          </select>
        </label>
      </div>

      {entries.length > 0 ? (
        <section className="flex flex-col gap-3" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-sm" data-testid="import-summary">
              {batchId ? t("import.summary", counts) : t("import.ready", { count: entries.length })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={running}
                onClick={() => {
                  setEntries([]);
                  setItems(new Map());
                  setBatchId(null);
                  setRejected([]);
                }}
              >
                <Trash2 />
                {t("import.clear")}
              </Button>
              <Button size="sm" disabled={!canStart} onClick={start}>
                <FileUp />
                {t("import.start")}
              </Button>
            </div>
          </div>
          <div className="border-border overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-surface-muted text-muted-foreground text-xs">
                <tr>
                  <th className="px-3 py-2 font-medium">{t("import.file")}</th>
                  <th className="px-3 py-2 font-medium">{t("import.status")}</th>
                  <th className="px-3 py-2 font-medium">{t("import.result")}</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {rows.map((row) => {
                  const { entry, item } = row;
                  const status = statusOf(row);
                  const variant =
                    status === "succeeded"
                      ? "success"
                      : status === "duplicate"
                        ? "accent"
                        : status === "failed" || status === "uploadError"
                          ? "danger"
                          : "neutral";
                  return (
                    <tr key={entry.key} data-testid="import-row">
                      <td className="max-w-[280px] px-3 py-2">
                        <p className="truncate font-medium">{entry.file.name}</p>
                        <p className="text-muted-foreground text-xs">
                          {formatBytes(entry.file.size)}
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={variant}>
                          {status === "uploading"
                            ? t("import.status.uploading", { percent: entry.progress })
                            : (tOptional(`import.status.${status}`) ?? status)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {item?.resultArtifactId &&
                        (item.status === "succeeded" || item.status === "duplicate") ? (
                          <Link
                            href={`/artifacts/${item.resultArtifactId}`}
                            className="text-primary hover:underline"
                          >
                            {tOptional(`import.outcome.${item.outcome}`) ?? t("import.open")}：
                            {item.resultArtifactTitle ?? t("import.open")}
                          </Link>
                        ) : null}
                        {status === "failed" && item ? (
                          <span className="text-danger flex items-center gap-2">
                            <span>
                              {item.errorCode}
                              {item.errorMessage ? `：${item.errorMessage}` : ""}
                            </span>
                            {item.retryable ? (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => retryServerItem(item.id)}
                              >
                                <RotateCcw />
                                {t("import.retry")}
                              </Button>
                            ) : item.resultArtifactId ? (
                              <Link
                                href={`/artifacts/${item.resultArtifactId}`}
                                className="text-primary shrink-0 hover:underline"
                              >
                                {t("import.inspectOriginal")}
                              </Link>
                            ) : null}
                          </span>
                        ) : null}
                        {status === "uploadError" ? (
                          <span className="text-danger">{entry.error}</span>
                        ) : null}
                        {item && item.warnings.length > 0 && item.status === "succeeded" ? (
                          <span className="text-muted-foreground block">
                            {item.warnings.length} 則處理備註
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {error ? (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
