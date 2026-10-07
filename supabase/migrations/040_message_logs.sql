-- ============================================================
-- 040 — message_logs: full audit trail of outbound WhatsApp events.
--
-- One row per event in an outbound message's life:
--   * send      — a send attempt to Meta (dashboard composer or the
--                 public /api/v1/messages API), success or failure.
--   * rejected  — a request we refused before reaching Meta
--                 (validation, unknown conversation, WhatsApp not
--                 configured, …).
--   * status    — a delivery status from Meta's webhook
--                 (sent / delivered / read / failed).
--
-- Failures keep Meta's COMPLETE error, not a one-line summary: the
-- structured fields (code, subcode, type, title, details, fbtrace_id,
-- HTTP status) plus the raw error / webhook object in `response`, and
-- the parameters we sent in `request`, so an operator can see exactly
-- what was attempted and why it failed.
--
-- Rows are written only by the server (service role). Members of the
-- account can read their account's logs; nobody can edit them.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS message_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  event TEXT NOT NULL CHECK (event IN ('send', 'rejected', 'status')),
  -- send: sent | failed; rejected: failed; status: Meta's status value.
  status TEXT NOT NULL
    CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  -- Where the event came from.
  source TEXT NOT NULL CHECK (source IN ('dashboard', 'api', 'webhook')),

  -- What the event is about. All nullable: a rejected request may
  -- never have resolved a conversation, and logs outlive messages.
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  whatsapp_message_id TEXT,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  recipient TEXT,
  message_type TEXT,
  template_name TEXT,
  template_language TEXT,

  -- Who triggered it (dashboard user or API key), when known.
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  api_key_id UUID,

  -- Complete error detail (NULL on success).
  error_code TEXT,
  error_subcode TEXT,
  error_type TEXT,
  error_title TEXT,
  error_message TEXT,
  error_details TEXT,
  fbtrace_id TEXT,
  http_status INT,

  -- Raw payloads for full fidelity. `request` is what we asked Meta to
  -- send (no credentials); `response` is Meta's raw error body or the
  -- webhook status object.
  request JSONB,
  response JSONB,
  duration_ms INT
);

CREATE INDEX IF NOT EXISTS idx_message_logs_account_created
  ON message_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_logs_account_failed
  ON message_logs(account_id, created_at DESC)
  WHERE status = 'failed';
CREATE INDEX IF NOT EXISTS idx_message_logs_wamid
  ON message_logs(whatsapp_message_id);
CREATE INDEX IF NOT EXISTS idx_message_logs_message
  ON message_logs(message_id);

ALTER TABLE message_logs ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+). No INSERT/UPDATE/DELETE
-- policies — the server writes with the service role, and an audit log
-- must not be editable from the client.
DROP POLICY IF EXISTS message_logs_select ON message_logs;
CREATE POLICY message_logs_select ON message_logs FOR SELECT
  USING (is_account_member(account_id));

-- Realtime so the Logs page streams new events.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'message_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE message_logs;
  END IF;
END $$;
