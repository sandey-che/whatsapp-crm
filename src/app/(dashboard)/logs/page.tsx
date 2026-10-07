"use client";

// Message logs — the audit trail of outbound WhatsApp events
// (`message_logs`, migration 040): every send attempt from the
// dashboard or the public API, every request rejected before Meta, and
// every delivery status from the webhook. Failures carry Meta's
// complete error; the detail sheet shows it with the raw request and
// response.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { MessageLog } from "@/types";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  Copy,
  Eye,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  XCircle,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 100;

type StatusFilter = "all" | MessageLog["status"];

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "sent", label: "Sent" },
  { value: "delivered", label: "Delivered" },
  { value: "read", label: "Read" },
];

const STATUS_META: Record<
  MessageLog["status"],
  { icon: typeof Send; className: string }
> = {
  failed: {
    icon: XCircle,
    className: "border-destructive/40 bg-destructive/10 text-destructive",
  },
  sent: { icon: Check, className: "border-border bg-muted text-foreground" },
  delivered: {
    icon: CheckCheck,
    className: "border-border bg-muted text-foreground",
  },
  read: {
    icon: Eye,
    className: "border-primary/40 bg-primary/10 text-primary",
  },
};

const EVENT_LABEL: Record<MessageLog["event"], string> = {
  send: "Send",
  rejected: "Rejected",
  status: "Status",
};

const SOURCE_LABEL: Record<MessageLog["source"], string> = {
  dashboard: "Dashboard",
  api: "API",
  webhook: "Webhook",
};

/** PostgREST `or()` filter values can't contain these. */
function sanitizeSearch(q: string): string {
  return q.replace(/[,()*%\\]/g, " ").trim();
}

function errorSummary(log: MessageLog): string | null {
  if (log.status !== "failed" && !log.error_message) return null;
  const code = log.error_code ? `(#${log.error_code}) ` : "";
  return `${code}${log.error_title || log.error_message || "Failed"}`;
}

export default function MessageLogsPage() {
  const { accountId } = useAuth();
  const [logs, setLogs] = useState<MessageLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<MessageLog | null>(null);

  // Debounce the search box so typing doesn't fire a query per key.
  useEffect(() => {
    const t = setTimeout(() => setSearch(sanitizeSearch(searchInput)), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchPage = useCallback(
    async (offset: number) => {
      if (!accountId) return null;
      const supabase = createClient();
      let query = supabase
        .from("message_logs")
        .select("*")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (status !== "all") query = query.eq("status", status);
      if (search) {
        const like = `%${search}%`;
        query = query.or(
          [
            `recipient.ilike.${like}`,
            `template_name.ilike.${like}`,
            `whatsapp_message_id.ilike.${like}`,
            `error_code.ilike.${like}`,
            `error_message.ilike.${like}`,
            `error_details.ilike.${like}`,
          ].join(","),
        );
      }
      const { data, error: fetchErr } = await query;
      if (fetchErr) {
        setError(fetchErr.message);
        return null;
      }
      const rows = (data ?? []) as MessageLog[];
      setHasMore(rows.length === PAGE_SIZE);
      return rows;
    },
    [accountId, status, search],
  );

  const load = useCallback(async () => {
    setError(null);
    const rows = await fetchPage(0);
    if (rows) setLogs(rows);
  }, [fetchPage]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!logs) return;
    setLoadingMore(true);
    const rows = await fetchPage(logs.length);
    setLoadingMore(false);
    if (rows) {
      setLogs((prev) => {
        const seen = new Set(prev?.map((l) => l.id));
        return [...(prev ?? []), ...rows.filter((r) => !seen.has(r.id))];
      });
    }
  }, [logs, fetchPage]);

  // Realtime — new events stream in at the top when they match the
  // current status filter. A search falls back to the Refresh button.
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    const channel = supabase
      .channel("message-logs-page")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "message_logs",
          filter: `account_id=eq.${accountId}`,
        },
        (payload) => {
          const row = payload.new as MessageLog;
          if (search) return;
          if (status !== "all" && row.status !== status) return;
          setLogs((prev) => {
            if (!prev) return [row];
            if (prev.some((l) => l.id === row.id)) return prev;
            return [row, ...prev];
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [accountId, status, search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Message logs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every outbound WhatsApp event — sends, rejections and delivery
            statuses — with the complete error for anything that failed.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatus(f.value)}
              className={cn(
                "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                status === f.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search phone, template, wamid, error…"
            className="pl-9"
          />
        </div>
      </div>

      {error ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      ) : logs === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : logs.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/40">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <ScrollText className="h-6 w-6 text-primary" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">
            No log entries
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {status !== "all" || search
              ? "Nothing matches these filters."
              : "Events appear here as soon as a message is sent."}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Event</th>
                  <th className="px-4 py-2 font-medium">Recipient</th>
                  <th className="px-4 py-2 font-medium">Message</th>
                  <th className="px-4 py-2 font-medium">Error</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => {
                  const meta = STATUS_META[log.status];
                  const Icon = meta.icon;
                  const summary = errorSummary(log);
                  return (
                    <tr
                      key={log.id}
                      onClick={() => setSelected(log)}
                      className="cursor-pointer border-t border-border transition-colors hover:bg-muted/40"
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                        <span title={format(new Date(log.created_at), "PPpp")}>
                          {formatDistanceToNow(new Date(log.created_at), {
                            addSuffix: true,
                          })}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize",
                            meta.className,
                          )}
                        >
                          <Icon className="size-3" />
                          {log.status}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs">
                        {EVENT_LABEL[log.event]}
                        <span className="text-muted-foreground">
                          {" · "}
                          {SOURCE_LABEL[log.source]}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">
                        {log.recipient ?? "—"}
                      </td>
                      <td className="max-w-48 truncate px-4 py-2.5 text-xs">
                        {log.template_name ? (
                          <span title={log.template_name}>
                            {log.template_name}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {log.message_type ?? "—"}
                          </span>
                        )}
                      </td>
                      <td className="max-w-80 truncate px-4 py-2.5 text-xs text-destructive">
                        {summary ? (
                          <span title={summary}>{summary}</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && <LogDetail log={selected} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function LogDetail({ log }: { log: MessageLog }) {
  const meta = STATUS_META[log.status];
  const Icon = meta.icon;
  const failed = log.status === "failed";

  const fields: [string, React.ReactNode][] = [
    ["Time", format(new Date(log.created_at), "PPpp")],
    ["Event", `${EVENT_LABEL[log.event]} · ${SOURCE_LABEL[log.source]}`],
    ["Recipient", log.recipient],
    ["Message type", log.message_type],
    ["Template", log.template_name],
    ["Template language", log.template_language],
    ["WhatsApp message id", log.whatsapp_message_id],
    ["Message id", log.message_id],
    ["API key id", log.api_key_id],
    ["User id", log.user_id],
    [
      "Duration",
      log.duration_ms !== null ? `${log.duration_ms} ms` : null,
    ],
  ];

  const errorFields: [string, React.ReactNode][] = [
    ["Code", log.error_code],
    ["Subcode", log.error_subcode],
    ["Type", log.error_type],
    ["Title", log.error_title],
    ["Message", log.error_message],
    ["Details", log.error_details],
    ["HTTP status", log.http_status],
    ["fbtrace_id", log.fbtrace_id],
  ];
  const hasError = errorFields.some(([, v]) => v !== null && v !== "");

  return (
    <div className="flex flex-col gap-6 p-4 pt-2">
      <SheetHeader className="p-0">
        <SheetTitle className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
              meta.className,
            )}
          >
            <Icon className="size-3" />
            {log.status}
          </span>
          {EVENT_LABEL[log.event]} event
        </SheetTitle>
        <SheetDescription className="font-mono text-xs">
          {log.id}
        </SheetDescription>
      </SheetHeader>

      {hasError && (
        <section
          className={cn(
            "rounded-lg border p-3",
            failed
              ? "border-destructive/40 bg-destructive/5"
              : "border-amber-500/40 bg-amber-500/5",
          )}
        >
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <AlertTriangle
              className={cn(
                "size-4",
                failed ? "text-destructive" : "text-amber-500",
              )}
            />
            Error
          </h3>
          <FieldList fields={errorFields} />
        </section>
      )}

      <section>
        <h3 className="mb-2 text-sm font-semibold">Details</h3>
        <FieldList fields={fields} />
        {log.conversation_id && (
          <Link
            href={`/inbox?c=${log.conversation_id}`}
            className="mt-3 inline-block text-xs font-medium text-primary hover:underline"
          >
            Open conversation →
          </Link>
        )}
      </section>

      <JsonBlock title="Request" value={log.request} />
      <JsonBlock
        title={log.event === "status" ? "Webhook payload" : "Response"}
        value={log.response}
      />
    </div>
  );
}

function FieldList({ fields }: { fields: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
      {fields
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-all font-mono">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const [copied, setCopied] = useState(false);
  if (value === null || value === undefined) return null;
  const text = JSON.stringify(value, null, 2);
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => {},
            );
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
        {text}
      </pre>
    </section>
  );
}
