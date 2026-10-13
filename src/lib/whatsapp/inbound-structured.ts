/**
 * Structured inbound WhatsApp content — catalog orders, shared contacts,
 * WhatsApp Flow form responses, product enquiries and ad referrals.
 *
 * None of these fit `content_text` / `media_url`. Before migration 049
 * the webhook either didn't recognise them (an order landed in the inbox
 * as "[Unsupported message type: order]") or kept only the text and
 * dropped the rest. Now the raw Meta message is stored in
 * `messages.inbound_payload`, and the helpers here derive the plain-text
 * summary that goes into `content_text` — which is what the conversation
 * preview, automations, the AI auto-reply and the `message.received`
 * webhook all read.
 *
 * Pure and dependency-free: the inbox bubble imports the types and
 * `orderTotal` client-side.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */

/** One cart line of an inbound order. Meta may send numbers as strings. */
export interface WaOrderItem {
  product_retailer_id?: string
  quantity?: number | string
  item_price?: number | string
  currency?: string
}

/** `messages[].order` — sent when a customer submits a catalog cart. */
export interface WaOrder {
  catalog_id?: string
  /** Optional note the customer typed alongside the cart. */
  text?: string
  product_items?: WaOrderItem[]
}

/** `messages[].contacts[]` — a contact card the customer shared. */
export interface WaSharedContact {
  name?: { formatted_name?: string; first_name?: string; last_name?: string }
  phones?: { phone?: string; wa_id?: string; type?: string }[]
}

/** `interactive.nfm_reply` — a submitted WhatsApp Flow form. */
export interface WaNfmReply {
  name?: string
  body?: string
  /** JSON-encoded form answers, as Meta sends it. */
  response_json?: string
}

/** `context.referred_product` — "Message business" tapped on a product. */
export interface WaReferredProduct {
  catalog_id?: string
  product_retailer_id?: string
}

/** `messages[].referral` — the message came from a click-to-WhatsApp ad. */
export interface WaReferral {
  source_url?: string
  source_type?: string
  source_id?: string
  headline?: string
  body?: string
}

/**
 * Shape of `messages.inbound_payload` — the raw Meta message, narrowed
 * to the parts the inbox renders. Other keys pass through untouched.
 */
export interface InboundMessagePayload {
  type?: string
  order?: WaOrder
  contacts?: WaSharedContact[]
  referral?: WaReferral
  context?: { id?: string; referred_product?: WaReferredProduct }
  interactive?: { type?: string; nfm_reply?: WaNfmReply }
  [key: string]: unknown
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** Round to cents without float noise (0.1 + 0.2 → 0.3). */
const money = (n: number): number => Math.round(n * 100) / 100

/**
 * Item count and cart total. `total` / `currency` are null when any line
 * lacks a price, or the lines mix currencies — a wrong total is worse
 * than none.
 */
export function orderTotal(order: WaOrder | null | undefined): {
  itemCount: number
  total: number | null
  currency: string | null
} {
  const items = order?.product_items ?? []
  let itemCount = 0
  let total = 0
  let priced = items.length > 0
  const currencies = new Set<string>()

  for (const item of items) {
    const qty = num(item.quantity) ?? 1
    itemCount += qty
    const price = num(item.item_price)
    if (price === null) priced = false
    else total += qty * price
    if (item.currency) currencies.add(item.currency)
  }

  if (!priced || currencies.size > 1) {
    return { itemCount, total: null, currency: null }
  }
  return {
    itemCount,
    total: money(total),
    currency: currencies.size === 1 ? [...currencies][0] : null,
  }
}

/**
 * Plain-text order summary for `content_text`, e.g.
 *
 *   Order: 3 items, total 1497 INR
 *   - 2 x SKU-1 @ 499 INR
 *   - 1 x SKU-2 @ 499 INR
 *   Note: please deliver after 6pm
 *
 * Meta sends only retailer ids, not product names.
 */
export function summarizeOrder(order: WaOrder | null | undefined): string {
  const items = order?.product_items ?? []
  const { itemCount, total, currency } = orderTotal(order)

  let head = `Order: ${itemCount} item${itemCount === 1 ? '' : 's'}`
  if (total !== null) head += `, total ${total}${currency ? ` ${currency}` : ''}`

  const lines = [head]
  for (const item of items) {
    const qty = num(item.quantity) ?? 1
    const price = num(item.item_price)
    let line = `- ${qty} x ${item.product_retailer_id || 'unknown item'}`
    if (price !== null) line += ` @ ${price}${item.currency ? ` ${item.currency}` : ''}`
    lines.push(line)
  }
  if (order?.text?.trim()) lines.push(`Note: ${order.text.trim()}`)
  return lines.join('\n')
}

/** "Contact: Jane Doe (+15551234567)" — one line per shared card. */
export function summarizeContacts(
  contacts: WaSharedContact[] | null | undefined
): string | null {
  const lines = (contacts ?? []).map((c) => {
    const name =
      c.name?.formatted_name ||
      [c.name?.first_name, c.name?.last_name].filter(Boolean).join(' ') ||
      'Unnamed contact'
    const phones = (c.phones ?? [])
      .map((p) => p.phone || p.wa_id)
      .filter(Boolean)
    return phones.length > 0 ? `Contact: ${name} (${phones.join(', ')})` : `Contact: ${name}`
  })
  return lines.length > 0 ? lines.join('\n') : null
}

/**
 * Readable Flow form response: "Form response: name: Jane, size: M".
 * `flow_token` is Meta's correlation id, not an answer, so it's skipped.
 * Falls back to the reply's `body` when the JSON is missing or invalid.
 */
export function summarizeNfmReply(reply: WaNfmReply | null | undefined): string {
  let answers: Record<string, unknown> | null = null
  try {
    const parsed = reply?.response_json ? JSON.parse(reply.response_json) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) answers = parsed
  } catch {
    answers = null
  }

  const pairs = Object.entries(answers ?? {})
    .filter(([k]) => k !== 'flow_token')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)

  if (pairs.length > 0) return `Form response: ${pairs.join(', ')}`
  return reply?.body || 'Form response'
}
