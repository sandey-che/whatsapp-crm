// ============================================================
// message_logs writer — the audit trail of outbound WhatsApp events
// (migration 040). Every send attempt, pre-Meta rejection and webhook
// delivery status lands here with the complete error detail, and the
// dashboard's Logs page reads it back.
//
// Writes use the service-role client: the table has no client INSERT
// policy (an audit log must not be writable from the browser), and the
// dashboard send path otherwise runs on an RLS-scoped user client.
//
// Best-effort by design: logging must never turn a successful send
// into a failure or mask the real error, so this never throws.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

export type MessageLogEvent = 'send' | 'rejected' | 'status';
export type MessageLogStatus = 'sent' | 'delivered' | 'read' | 'failed';
export type MessageLogSource = 'dashboard' | 'api' | 'webhook';

/** Who triggered a send — a dashboard user or a public-API key. */
export interface MessageLogActor {
  source: Exclude<MessageLogSource, 'webhook'>;
  userId?: string | null;
  apiKeyId?: string | null;
}

export interface MessageLogErrorFields {
  error_code: string | null;
  error_subcode: string | null;
  error_type: string | null;
  error_title: string | null;
  error_message: string | null;
  error_details: string | null;
  fbtrace_id: string | null;
  http_status: number | null;
}

export interface MessageLogEntry extends Partial<MessageLogErrorFields> {
  account_id: string;
  event: MessageLogEvent;
  status: MessageLogStatus;
  source: MessageLogSource;
  message_id?: string | null;
  whatsapp_message_id?: string | null;
  conversation_id?: string | null;
  contact_id?: string | null;
  recipient?: string | null;
  message_type?: string | null;
  template_name?: string | null;
  template_language?: string | null;
  user_id?: string | null;
  api_key_id?: string | null;
  request?: unknown;
  response?: unknown;
  duration_ms?: number | null;
}

const str = (v: unknown): string | null =>
  v === undefined || v === null || v === '' ? null : String(v);

/**
 * Break any thrown error into the log's error columns + a raw
 * `response` payload. A `MetaApiError` contributes Meta's full error
 * object; anything else (network failure, timeout) its name/message.
 */
export function describeError(err: unknown): MessageLogErrorFields & {
  response: unknown;
} {
  if (err instanceof MetaApiError) {
    const m = err.metaError;
    const data = m?.error_data;
    return {
      error_code: str(m?.code ?? err.metaCode),
      error_subcode: str(m?.error_subcode),
      error_type: str(m?.type),
      error_title: str(m?.error_user_title),
      error_message: err.message,
      error_details:
        str(typeof data === 'string' ? data : data?.details) ??
        str(m?.error_user_msg),
      fbtrace_id: str(m?.fbtrace_id),
      http_status: err.httpStatus,
      response: m ? { error: m } : err.rawBody ? { raw: err.rawBody } : null,
    };
  }
  const e = err instanceof Error ? err : null;
  const cause = e?.cause instanceof Error ? e.cause.message : str(e?.cause);
  return {
    error_code: str((err as { code?: unknown })?.code),
    error_subcode: null,
    error_type: e?.name ?? typeof err,
    error_title: null,
    error_message: e?.message ?? String(err),
    error_details: cause,
    fbtrace_id: null,
    http_status: str((err as { status?: unknown })?.status)
      ? Number((err as { status?: unknown }).status)
      : null,
    response: {
      name: e?.name ?? null,
      message: e?.message ?? String(err),
      cause,
      stack: e?.stack?.split('\n').slice(0, 8).join('\n') ?? null,
    },
  };
}

/** Insert one log row. Never throws. */
export async function logMessageEvent(entry: MessageLogEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin().from('message_logs').insert(entry);
    if (error) {
      console.error('[message-log] insert failed:', error.message);
    }
  } catch (err) {
    console.error(
      '[message-log] insert threw:',
      err instanceof Error ? err.message : err
    );
  }
}
