-- ============================================================
-- 048 — message_log_threads: one row per outbound message.
--
-- `message_logs` (047) is an event stream: a single WhatsApp message
-- produces a `send` event and then `sent` / `delivered` / `read` (or
-- `failed`) webhook events. Listed raw, one message reads as three or
-- four unrelated rows. This view folds the events of each message into
-- a single "thread" so the Logs page can list messages, and show the
-- individual events only when a message is opened.
--
-- Grouping key (`thread_key`): Meta's wamid when there is one — it ties
-- the send to every later status. Events without a wamid (a send Meta
-- rejected, a request refused before Meta) are their own thread, keyed
-- by the log row id.
--
-- `status` is the furthest the message got: failed > read > delivered
-- > sent. A failure wins even if a stray success status arrives later,
-- since Meta doesn't promise ordering.
--
-- SECURITY: `security_invoker` makes the view run with the caller's
-- privileges, so message_logs' RLS (account members only) applies to
-- every row read through it. Without it the view would run as its
-- owner and bypass RLS.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE OR REPLACE VIEW message_log_threads
WITH (security_invoker = on) AS
SELECT
  account_id,
  COALESCE(whatsapp_message_id, id::text) AS thread_key,
  MAX(whatsapp_message_id) AS whatsapp_message_id,

  MIN(created_at) AS started_at,
  MAX(created_at) AS last_event_at,
  COUNT(*)::int AS event_count,

  CASE
    WHEN BOOL_OR(status = 'failed') THEN 'failed'
    WHEN BOOL_OR(status = 'read') THEN 'read'
    WHEN BOOL_OR(status = 'delivered') THEN 'delivered'
    ELSE 'sent'
  END AS status,

  -- How the thread began: a send we made, a request we refused, or
  -- only webhook statuses (the send was made by something that doesn't
  -- log, e.g. a broadcast or an older deployment).
  CASE
    WHEN BOOL_OR(event = 'rejected') THEN 'rejected'
    WHEN BOOL_OR(event = 'send') THEN 'send'
    ELSE 'status'
  END AS origin,
  COALESCE(
    (ARRAY_AGG(source ORDER BY created_at) FILTER (WHERE event <> 'status'))[1],
    'webhook'
  ) AS source,

  -- Descriptive fields: first non-null value across the thread.
  (ARRAY_AGG(recipient ORDER BY created_at) FILTER (WHERE recipient IS NOT NULL))[1] AS recipient,
  (ARRAY_AGG(message_type ORDER BY created_at) FILTER (WHERE message_type IS NOT NULL))[1] AS message_type,
  (ARRAY_AGG(template_name ORDER BY created_at) FILTER (WHERE template_name IS NOT NULL))[1] AS template_name,
  (ARRAY_AGG(template_language ORDER BY created_at) FILTER (WHERE template_language IS NOT NULL))[1] AS template_language,
  (ARRAY_AGG(message_id ORDER BY created_at) FILTER (WHERE message_id IS NOT NULL))[1] AS message_id,
  (ARRAY_AGG(conversation_id ORDER BY created_at) FILTER (WHERE conversation_id IS NOT NULL))[1] AS conversation_id,
  (ARRAY_AGG(contact_id ORDER BY created_at) FILTER (WHERE contact_id IS NOT NULL))[1] AS contact_id,

  -- When each delivery stage was reached.
  MIN(created_at) FILTER (WHERE status = 'sent') AS sent_at,
  MIN(created_at) FILTER (WHERE status = 'delivered') AS delivered_at,
  MIN(created_at) FILTER (WHERE status = 'read') AS read_at,
  MIN(created_at) FILTER (WHERE status = 'failed') AS failed_at,

  -- The latest failure's reason, for the list view.
  (ARRAY_AGG(error_code ORDER BY created_at DESC) FILTER (WHERE status = 'failed'))[1] AS error_code,
  (ARRAY_AGG(error_title ORDER BY created_at DESC) FILTER (WHERE status = 'failed'))[1] AS error_title,
  (ARRAY_AGG(error_message ORDER BY created_at DESC) FILTER (WHERE status = 'failed'))[1] AS error_message,
  (ARRAY_AGG(error_details ORDER BY created_at DESC) FILTER (WHERE status = 'failed'))[1] AS error_details
FROM message_logs
GROUP BY account_id, COALESCE(whatsapp_message_id, id::text);

COMMENT ON VIEW message_log_threads IS
  'One row per outbound WhatsApp message, folding its message_logs '
  'events (send + webhook statuses) together. security_invoker, so '
  'message_logs RLS applies.';

GRANT SELECT ON message_log_threads TO authenticated;
