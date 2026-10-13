import { describe, expect, it } from 'vitest'
import {
  orderTotal,
  summarizeContacts,
  summarizeNfmReply,
  summarizeOrder,
} from './inbound-structured'

describe('orderTotal', () => {
  it('sums quantity × price, accepting Meta numeric strings', () => {
    expect(
      orderTotal({
        product_items: [
          { quantity: 2, item_price: 0.1, currency: 'USD' },
          { quantity: '1', item_price: '0.2', currency: 'USD' },
        ],
      }),
    ).toEqual({ itemCount: 3, total: 0.4, currency: 'USD' })
  })

  it('omits the total when a line has no price', () => {
    expect(
      orderTotal({ product_items: [{ quantity: 1, item_price: 5 }, { quantity: 1 }] }),
    ).toEqual({ itemCount: 2, total: null, currency: null })
  })

  it('omits the total when currencies are mixed', () => {
    expect(
      orderTotal({
        product_items: [
          { quantity: 1, item_price: 5, currency: 'USD' },
          { quantity: 1, item_price: 5, currency: 'EUR' },
        ],
      }).total,
    ).toBeNull()
  })

  it('handles a missing order', () => {
    expect(orderTotal(undefined)).toEqual({ itemCount: 0, total: null, currency: null })
  })
})

describe('summarizeOrder', () => {
  it('lists each line and the note', () => {
    expect(
      summarizeOrder({
        text: '  ring the bell ',
        product_items: [{ product_retailer_id: 'A', quantity: 1, item_price: 10, currency: 'INR' }],
      }),
    ).toBe('Order: 1 item, total 10 INR\n- 1 x A @ 10 INR\nNote: ring the bell')
  })

  it('still names the order when items are missing', () => {
    expect(summarizeOrder({})).toBe('Order: 0 items')
  })
})

describe('summarizeContacts', () => {
  it('falls back to first/last name and lists every phone', () => {
    expect(
      summarizeContacts([
        { name: { first_name: 'Jane', last_name: 'Doe' }, phones: [{ phone: '+1' }, { wa_id: '2' }] },
        { phones: [] },
      ]),
    ).toBe('Contact: Jane Doe (+1, 2)\nContact: Unnamed contact')
  })

  it('returns null for no cards', () => {
    expect(summarizeContacts([])).toBeNull()
  })
})

describe('summarizeNfmReply', () => {
  it('falls back to the body when response_json is invalid', () => {
    expect(summarizeNfmReply({ body: 'Sent', response_json: '{oops' })).toBe('Sent')
  })

  it('serialises non-string answers', () => {
    expect(
      summarizeNfmReply({ response_json: JSON.stringify({ toppings: ['a', 'b'] }) }),
    ).toBe('Form response: toppings: ["a","b"]')
  })
})
