import { describe, expect, test } from 'bun:test'
import { looksLikeSpam } from '../src/build-invoice.js'

const order = (idea: string) => ({ email: 'pat@example.com', name: 'Pat', idea })
const template =
  'Hello, I have a few questions about pricing, availability, and the general process of working with you. Please let me know what details you need from me to proceed. Thanks!'

describe('looksLikeSpam (build by invoice)', () => {
  test('the stock pricing/availability/process note is spam (INV-043/044, 2026-10-28)', () => {
    expect(looksLikeSpam(order(template))).toBe(true)
  })

  test('the stock consultation note is spam', () => {
    expect(looksLikeSpam(order("Hello, I'm interested in scheduling a brief consultation. Thanks!"))).toBe(true)
  })

  test('selling SEO is spam', () => {
    expect(looksLikeSpam(order('We sell backlinks and guest post placements'))).toBe(true)
  })

  test('a real buyer who opens with the stock line still gets an invoice', () => {
    expect(looksLikeSpam(order(`${template}\nI want a booking page for my barbershop with SMS reminders.`))).toBe(false)
  })

  test('a short real idea is not spam', () => {
    expect(looksLikeSpam(order('A todo app for my team'))).toBe(false)
    expect(looksLikeSpam(order('A booking page for my barbershop\nwith reminders'))).toBe(false)
  })
})
