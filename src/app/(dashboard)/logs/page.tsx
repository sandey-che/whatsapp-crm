"use client";

// Message logs — one row per outbound WhatsApp message.
//
// The audit trail (`message_logs`, migration 047) is an event stream: a
// send, then Meta's sent / delivered / read (or failed) webhooks. The
// list reads `message_log_threads` (migration 048), which folds those
// events into one row per message with a delivery tracker; opening a
// message shows its individual events as a timeline, each with Meta's
// complete error and the raw request / response.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { MessageLog, MessageLogThread } from "@/types";
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  Loader2,
  MessageSquare,
  RefreshCw,
  ScrollText,
  Search,
  Send,
  XCircle,
} from "lucide-react";
import { format, formatDistanceStrict, formatDistanceToNow } from "date-fns";
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

const PAGE_SIZE = 50;

type Status = MessageLogThread["status"];
type StatusFilter = "all" | Status;

const FILTERS: { value: StatusFilter; label: string; hint: string }[] = [
  { value: "all", label: "All", hint: "Every message" },
  { value: "failed", label: "Failed", hint: "Rejected or undeliverable" },
  { value: "sent", label: "Sent", hint: "Accepted by Meta, not yet delivered" },
  { value: "delivered", label: "Delivered", hint: "Delivered, not yet read" },
  { value: "read", label: "Read", hint: "Opened by the recipient" },
];

// One visual language for status across the list, tracker and timeline.
const STATUS_STYLE: Record<
  Status,
  { label: string; icon: typeof Send; pill: string; dot: string }
> = {
  sent: {
    label: "Sent",
    icon: Check,
    pill: "border-border bg-muted text-foreground",
    dot: "bg-muted-foreground",
  },
  delivered: {
    label: "Delivered",
    icon: CheckCheck,
    pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  read: {
    label: "Read",
    icon: Eye,
    pill: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    pill: "border-destructive/40 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
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

function messageTitle(t: Pick<MessageLogThread, "template_name" | "message_type">) {
  if (t.template_name) return t.template_name;
  if (!t.message_type) return "Message";
  return `${t.message_type.charAt(0).toUpperCase()}${t.message_type.slice(1)} message`;
}

function errorLine(e: {
  error_code: string | null;
  error_title: string | null;
  error_message: string | null;
}): string {
  const code = e.error_code ? `#${e.error_code} · ` : "";
  return `${code}${e.error_title || e.error_message || "Failed"}`;
}

function applySearch<Q extends { or: (f: string) => Q }>(query: Q, search: string): Q {
  if (!search) return query;
  const like = `%${search}%`;
  return query.or(
    [
      `recipient.ilike.${like}`,
      `template_name.ilike.${like}`,
      `thread_key.ilike.${like}`,
      `error_code.ilike.${like}`,
      `error_title.ilike.${like}`,
      `error_message.ilike.${like}`,
      `error_details.ilike.${like}`,
    ].join(","),
  );
}

// ============================================================
// Page
// ============================================================

export default function MessageLogsPage() {
  const { accountId } = useAuth();
  const [threads, setThreads] = useState<MessageLogThread[] | null>(null);
  const [counts, setCounts] = useState<Partial<Record<StatusFilter, number>>>({});
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);

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
        .from("message_log_threads")
        .select("*")
        .eq("account_id", accountId)
        .order("started_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);
      if (filter !== "all") query = query.eq("status", filter);
      query = applySearch(query, search);
      const { data, error: fetchErr } = await query;
      if (fetchErr) {
        setError(fetchErr.message);
        return null;
      }
      const rows = (data ?? []) as MessageLogThread[];
      setHasMore(rows.length === PAGE_SIZE);
      return rows;
    },
    [accountId, filter, search],
  );

  // Per-tab counts, scoped to the current search.
  const loadCounts = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const results = await Promise.all(
      FILTERS.map(async (f) => {
        let q = supabase
          .from("message_log_threads")
          .select("thread_key", { count: "exact", head: true })
          .eq("account_id", accountId);
        if (f.value !== "all") q = q.eq("status", f.value);
        q = applySearch(q, search);
        const { count } = await q;
        return [f.value, count ?? 0] as const;
      }),
    );
    setCounts(Object.fromEntries(results));
  }, [accountId, search]);

  const load = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    const [rows] = await Promise.all([fetchPage(0), loadCounts()]);
    setRefreshing(false);
    if (rows) setThreads(rows);
  }, [fetchPage, loadCounts]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!threads) return;
    setLoadingMore(true);
    const rows = await fetchPage(threads.length);
    setLoadingMore(false);
    if (rows) {
      setThreads((prev) => {
        const seen = new Set(prev?.map((t) => t.thread_key));
        return [...(prev ?? []), ...rows.filter((r) => !seen.has(r.thread_key))];
      });
    }
  }, [threads, fetchPage]);

  // Realtime — a new event re-reads just its message's thread and
  // updates that row in place (a status webhook advances the tracker
  // rather than adding a row). Counts refresh on a short debounce.
  const filterRef = useRef(filter);
  const searchRef = useRef(search);
  useEffect(() => {
    filterRef.current = filter;
    searchRef.current = search;
  }, [filter, search]);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let countsTimer: ReturnType<typeof setTimeout> | undefined;

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
        async (payload) => {
          const row = payload.new as MessageLog;
          const key = row.whatsapp_message_id ?? row.id;
          const { data } = await supabase
            .from("message_log_threads")
            .select("*")
            .eq("account_id", accountId)
            .eq("thread_key", key)
            .maybeSingle();
          const thread = data as MessageLogThread | null;
          if (!thread) return;

          const f = filterRef.current;
          const matches = f === "all" || thread.status === f;
          setThreads((prev) => {
            if (!prev) return prev;
            const idx = prev.findIndex((t) => t.thread_key === key);
            if (idx >= 0) {
              // Advanced out of the current filter (e.g. Sent → Delivered
              // while viewing "Sent") — drop it from this view.
              if (!matches) return prev.filter((_, i) => i !== idx);
              const next = [...prev];
              next[idx] = thread;
              return next;
            }
            // New message: only prepend when nothing would hide it.
            if (!matches || searchRef.current) return prev;
            return [thread, ...prev];
          });

          clearTimeout(countsTimer);
          countsTimer = setTimeout(loadCounts, 800);
        },
      )
      .subscribe();

    return () => {
      clearTimeout(countsTimer);
      supabase.removeChannel(channel);
    };
  }, [accountId, loadCounts]);

  const open = threads?.find((t) => t.thread_key === openKey) ?? null;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Message logs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every WhatsApp message sent from this account, and how far it got.
            Open a message to see each event and the full error.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={refreshing}>
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="Filter by status"
          className="-mx-1 flex gap-1 overflow-x-auto px-1"
        >
          {FILTERS.map((f) => {
            const active = filter === f.value;
            const count = counts[f.value];
            return (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={active}
                title={f.hint}
                onClick={() => setFilter(f.value)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  active
                    ? "border-foreground/20 bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {f.value !== "all" && (
                  <span
                    aria-hidden
                    className={cn("size-1.5 rounded-full", STATUS_STYLE[f.value].dot)}
                  />
                )}
                {f.label}
                {count !== undefined && (
                  <span
                    className={cn(
                      "tabular-nums",
                      active ? "text-background/70" : "text-muted-foreground/70",
                      f.value === "failed" && count > 0 && !active && "text-destructive",
                    )}
                  >
                    {count.toLocaleString()}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Phone, template, wamid or error"
            aria-label="Search messages"
            className="pl-9"
          />
        </div>
      </div>

      {/* List */}
      {error ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-border">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </div>
      ) : threads === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : threads.length === 0 ? (
        <EmptyState filtered={filter !== "all" || !!search} />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {/* Column headings — desktop only; rows stack on mobile. */}
            <div className="hidden grid-cols-[minmax(0,1fr)_14rem_7rem_7.5rem_1rem] items-center gap-4 border-b border-border bg-muted/40 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:grid">
              <span>Message</span>
              <span>Delivery</span>
              <span>Status</span>
              <span className="text-right">Sent</span>
              <span />
            </div>
            <ul className="divide-y divide-border">
              {threads.map((t) => (
                <ThreadRow
                  key={t.thread_key}
                  thread={t}
                  onOpen={() => setOpenKey(t.thread_key)}
                />
              ))}
            </ul>
          </div>
          {hasMore && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      <Sheet
        open={open !== null}
        onOpenChange={(o) => {
          if (!o) setOpenKey(null);
        }}
      >
        <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-xl">
          {open && <ThreadDetail thread={open} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex h-56 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
        <ScrollText className="h-6 w-6 text-primary" />
      </div>
      <p className="mt-3 text-sm font-medium text-foreground">
        {filtered ? "No messages match" : "No messages yet"}
      </p>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">
        {filtered
          ? "Try another status or clear the search."
          : "Messages sent from the inbox or the API appear here, with their delivery progress."}
      </p>
    </div>
  );
}

// ============================================================
// List row
// ============================================================

function StatusPill({ status }: { status: Status }) {
  const s = STATUS_STYLE[status];
  const Icon = s.icon;
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        s.pill,
      )}
    >
      <Icon className="size-3" />
      {s.label}
    </span>
  );
}

function ThreadRow({ thread: t, onOpen }: { thread: MessageLogThread; onOpen: () => void }) {
  const failed = t.status === "failed";
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none md:grid-cols-[minmax(0,1fr)_14rem_7rem_7.5rem_1rem]"
      >
        {/* Message */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {messageTitle(t)}
            </span>
            {t.origin === "rejected" && (
              <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Not sent
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{t.recipient ?? "Unknown recipient"}</span>
            <span aria-hidden>·</span>
            <span>{SOURCE_LABEL[t.source]}</span>
          </div>
          {failed && (
            <p
              className="mt-1 truncate text-xs text-destructive"
              title={[errorLine(t), t.error_details].filter(Boolean).join(" — ")}
            >
              {errorLine(t)}
            </p>
          )}
        </div>

        {/* Delivery tracker — desktop */}
        <div className="hidden md:block">
          <DeliveryTracker thread={t} compact />
        </div>

        {/* Status — on mobile it sits top-right of the card */}
        <div className="row-start-1 flex justify-end md:row-auto md:justify-start">
          <StatusPill status={t.status} />
        </div>

        {/* Time */}
        <div className="col-span-2 text-xs text-muted-foreground md:col-span-1 md:text-right">
          <span title={format(new Date(t.started_at), "PPpp")}>
            {formatDistanceToNow(new Date(t.started_at), { addSuffix: true })}
          </span>
        </div>

        <ChevronRight className="hidden size-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground md:block" />
      </button>
    </li>
  );
}

// ============================================================
// Delivery tracker — Sent → Delivered → Read, or a failure stop.
// ============================================================

type Step = {
  key: string;
  label: string;
  at: string | null;
  state: "done" | "failed" | "todo";
};

function trackerSteps(t: MessageLogThread): Step[] {
  const delivered = t.delivered_at ?? t.read_at; // a read implies delivery
  // "Sent" is reached by Meta's sent status or an accepted send; a
  // later stage also implies it.
  const sentAt =
    t.sent_at ??
    (t.origin === "send" && t.status !== "failed" ? t.started_at : null) ??
    (delivered ? t.started_at : null);
  const steps: Step[] = [
    { key: "sent", label: "Sent", at: sentAt, state: "todo" },
    { key: "delivered", label: "Delivered", at: delivered, state: "todo" },
    { key: "read", label: "Read", at: t.read_at, state: "todo" },
  ];
  for (const s of steps) if (s.at) s.state = "done";

  if (t.status === "failed") {
    // The failure replaces the first stage not reached; later stages
    // won't happen, so they're dropped.
    const i = steps.findIndex((s) => s.state === "todo");
    const at = i >= 0 ? i : steps.length - 1;
    steps[at] = {
      key: "failed",
      label: t.origin === "rejected" ? "Rejected" : "Failed",
      at: t.failed_at ?? t.last_event_at,
      state: "failed",
    };
    steps.length = at + 1;
  }
  return steps;
}

function DeliveryTracker({
  thread,
  compact = false,
}: {
  thread: MessageLogThread;
  compact?: boolean;
}) {
  const steps = trackerSteps(thread);
  // Reached stages take the colour of the furthest stage reached.
  const reached = STATUS_STYLE[thread.status === "failed" ? "sent" : thread.status].dot;

  return (
    <ol aria-label="Delivery progress" className="flex items-start">
      {steps.map((s, i) => {
        const next = steps[i + 1];
        return (
          <li key={s.key} className="flex min-w-0 flex-1 items-start last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <span
                title={s.at ? `${s.label} · ${format(new Date(s.at), "PPpp")}` : `${s.label} · not yet`}
                className={cn(
                  "flex items-center justify-center rounded-full",
                  compact ? "size-2.5" : "size-7",
                  s.state === "done" && reached,
                  s.state === "failed" && "bg-destructive",
                  s.state === "todo" && "border border-dashed border-muted-foreground/40",
                )}
              >
                {!compact && s.state === "done" && <Check className="size-3.5 text-white" />}
                {!compact && s.state === "failed" && <XCircle className="size-4 text-white" />}
              </span>
              <span
                className={cn(
                  "whitespace-nowrap",
                  compact ? "text-[10px]" : "text-xs font-medium",
                  s.state === "failed"
                    ? "text-destructive"
                    : s.state === "done"
                      ? "text-foreground"
                      : "text-muted-foreground/60",
                )}
              >
                {s.label}
              </span>
              {!compact && (
                <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground">
                  {s.at ? format(new Date(s.at), "p") : "—"}
                </span>
              )}
            </div>
            {next && (
              <div className="relative flex-1 px-1.5">
                <span
                  className={cn(
                    "block h-px w-full",
                    compact ? "mt-[5px]" : "mt-3.5",
                    next.state === "done" && reached,
                    next.state === "failed" && "bg-destructive/50",
                    next.state === "todo" && "bg-border",
                  )}
                />
                {/* Time between stages — the number support asks about. */}
                {!compact && next.state !== "todo" && next.at && s.at && (
                  <span className="absolute inset-x-0 top-5 text-center text-[10px] text-muted-foreground">
                    +{formatDistanceStrict(new Date(next.at), new Date(s.at))}
                  </span>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ============================================================
// Detail sheet
// ============================================================

const EVENT_COPY: Record<string, { title: string; icon: typeof Send }> = {
  "send:sent": { title: "Send request accepted by Meta", icon: Send },
  "send:failed": { title: "Meta rejected the send", icon: XCircle },
  "rejected:failed": { title: "Request refused before sending", icon: Ban },
  "status:sent": { title: "Sent — Meta dispatched the message", icon: Check },
  "status:delivered": { title: "Delivered to the recipient's device", icon: CheckCheck },
  "status:read": { title: "Read by the recipient", icon: Eye },
  "status:failed": { title: "Delivery failed", icon: XCircle },
};

function ThreadDetail({ thread: t }: { thread: MessageLogThread }) {
  const [events, setEvents] = useState<MessageLog[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // (Re)load the events whenever the thread changes — including a
  // realtime status arriving while the sheet is open (event_count bumps).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      let q = supabase
        .from("message_logs")
        .select("*")
        .eq("account_id", t.account_id)
        .order("created_at", { ascending: true });
      q = t.whatsapp_message_id
        ? q.eq("whatsapp_message_id", t.whatsapp_message_id)
        : q.eq("id", t.thread_key);
      const { data, error } = await q;
      if (cancelled) return;
      if (error) setLoadError(error.message);
      else setEvents((data ?? []) as MessageLog[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [t.account_id, t.thread_key, t.whatsapp_message_id, t.event_count]);

  // The latest failure carries the complete error for the error card.
  const failure = events
    ?.slice()
    .reverse()
    .find((e) => e.status === "failed");

  const details: [string, React.ReactNode][] = [
    ["Recipient", t.recipient],
    ["Message type", t.message_type],
    ["Template", t.template_name],
    ["Language", t.template_language],
    ["Started", format(new Date(t.started_at), "PPpp")],
    ["Source", SOURCE_LABEL[t.source]],
    ["WhatsApp id", t.whatsapp_message_id ? <CopyText text={t.whatsapp_message_id} /> : null],
    ["Message id", t.message_id ? <CopyText text={t.message_id} /> : null],
  ];

  return (
    <div className="flex flex-col">
      <SheetHeader className="gap-2 border-b border-border p-5 pr-12">
        <div className="flex items-center gap-2">
          <StatusPill status={t.status} />
          <span className="text-xs text-muted-foreground">
            {t.event_count} event{t.event_count === 1 ? "" : "s"}
          </span>
        </div>
        <SheetTitle className="text-lg leading-tight">{messageTitle(t)}</SheetTitle>
        <SheetDescription className="font-mono text-xs">
          To {t.recipient ?? "unknown recipient"}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-6 p-5">
        <section
          aria-label="Delivery progress"
          className="rounded-xl border border-border bg-muted/30 px-4 pb-7 pt-4"
        >
          <DeliveryTracker thread={t} />
        </section>

        {t.status === "failed" && (
          <section className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-destructive">
              <AlertTriangle className="size-4 shrink-0" />
              {failure?.error_title ||
                failure?.error_message ||
                t.error_title ||
                t.error_message ||
                "Failed"}
            </h3>
            {(failure?.error_details ?? t.error_details) && (
              <p className="mt-1.5 text-sm text-foreground/90">
                {failure?.error_details ?? t.error_details}
              </p>
            )}
            {failure && (
              <FieldList
                className="mt-3"
                fields={[
                  ["Code", failure.error_code],
                  ["Subcode", failure.error_subcode],
                  ["Type", failure.error_type],
                  ["Message", failure.error_title ? failure.error_message : null],
                  ["HTTP status", failure.http_status],
                  [
                    "fbtrace_id",
                    failure.fbtrace_id ? <CopyText text={failure.fbtrace_id} /> : null,
                  ],
                ]}
              />
            )}
          </section>
        )}

        <section>
          <h3 className="mb-3 text-sm font-semibold">Activity</h3>
          {loadError ? (
            <p className="text-sm text-destructive">{loadError}</p>
          ) : events === null ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : (
            <ol>
              {events.map((e, i) => (
                <TimelineEvent
                  key={e.id}
                  event={e}
                  startedAt={events[0].created_at}
                  isFirst={i === 0}
                  isLast={i === events.length - 1}
                />
              ))}
            </ol>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Details</h3>
          <FieldList fields={details} />
          {t.conversation_id && (
            <Link
              href={`/inbox?c=${t.conversation_id}`}
              className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              <MessageSquare className="size-3.5" />
              Open conversation
            </Link>
          )}
        </section>
      </div>
    </div>
  );
}

function TimelineEvent({
  event: e,
  startedAt,
  isFirst,
  isLast,
}: {
  event: MessageLog;
  startedAt: string;
  isFirst: boolean;
  isLast: boolean;
}) {
  const failed = e.status === "failed";
  // Failures open with their payload showing — that's what's being debugged.
  const [showRaw, setShowRaw] = useState(failed);
  const copy = EVENT_COPY[`${e.event}:${e.status}`] ?? {
    title: `${e.event} · ${e.status}`,
    icon: Send,
  };
  const Icon = copy.icon;
  const hasRaw = e.request != null || e.response != null;

  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {!isLast && (
        <span
          aria-hidden
          className="absolute left-[13px] top-7 h-[calc(100%-1.75rem)] w-px bg-border"
        />
      )}
      <span
        className={cn(
          "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full text-white",
          failed
            ? "bg-destructive"
            : e.event === "status"
              ? STATUS_STYLE[e.status].dot
              : "bg-primary text-primary-foreground",
        )}
      >
        <Icon className="size-3.5" />
      </span>

      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p className={cn("text-sm font-medium", failed && "text-destructive")}>
            {copy.title}
          </p>
          <time
            dateTime={e.created_at}
            title={format(new Date(e.created_at), "PPpp")}
            className="shrink-0 text-xs tabular-nums text-muted-foreground"
          >
            {format(new Date(e.created_at), "p")}
            {!isFirst && (
              <span className="ml-1 text-muted-foreground/70">
                +{formatDistanceStrict(new Date(e.created_at), new Date(startedAt))}
              </span>
            )}
          </time>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {SOURCE_LABEL[e.source]}
          {e.duration_ms != null && ` · Meta responded in ${e.duration_ms} ms`}
          {e.error_type === "db_error" && " · saved with a database error"}
        </p>
        {failed && (
          <p className="mt-1.5 text-xs text-destructive">
            {errorLine(e)}
            {e.error_details && (
              <span className="text-foreground/80"> — {e.error_details}</span>
            )}
          </p>
        )}

        {hasRaw && (
          <>
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              aria-expanded={showRaw}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={cn("size-3.5 transition-transform", !showRaw && "-rotate-90")}
              />
              {showRaw ? "Hide payload" : "Show payload"}
            </button>
            {showRaw && (
              <div className="mt-2 space-y-3">
                <JsonBlock title="Request" value={e.request} />
                <JsonBlock
                  title={e.event === "status" ? "Webhook payload" : "Response"}
                  value={e.response}
                />
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

// ============================================================
// Small pieces
// ============================================================

function FieldList({
  fields,
  className,
}: {
  fields: [string, React.ReactNode][];
  className?: string;
}) {
  const shown = fields.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (shown.length === 0) return null;
  return (
    <dl className={cn("grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs", className)}>
      {shown.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-all font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  return { copied, copy };
}

function CopyText({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      title="Copy"
      className="group inline-flex max-w-full items-start gap-1 text-left hover:text-foreground"
    >
      <span className="break-all">{text}</span>
      {copied ? (
        <Check className="mt-0.5 size-3 shrink-0 text-emerald-500" />
      ) : (
        <Copy className="mt-0.5 size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
      )}
    </button>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const { copied, copy } = useCopy();
  if (value === null || value === undefined) return null;
  const text = JSON.stringify(value, null, 2);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <Button variant="ghost" size="xs" onClick={() => copy(text)}>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
        {text}
      </pre>
    </div>
  );
}
