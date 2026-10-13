-- ============================================================
-- 049 — inbound_message_payload: keep structured inbound content.
--
-- The webhook only understood a fixed set of Meta message types. Any
-- other type — most visibly a catalog ORDER (`type: 'order'`) — fell
-- through to a "[Unsupported message type: …]" placeholder, and since
-- nothing stored Meta's payload, the order's products, quantities and
-- prices were lost for good.
--
--   1. messages.inbound_payload — the raw Meta message object for
--      inbound messages whose content doesn't fit `content_text` /
--      `media_url`: orders, shared contacts, WhatsApp Flow form
--      responses, product enquiries, ad referrals, and any type the
--      webhook doesn't recognise yet. NULL for plain text / media.
--      Distinct from `interactive_payload` (035), which holds OUTBOUND
--      interactive messages.
--
--   2. Widens the content_type CHECK to allow 'order' so the inbox can
--      render the cart rather than a flattened string.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS inbound_payload JSONB;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_content_type_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN (
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive', 'order'
  ));
