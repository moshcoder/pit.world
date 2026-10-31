/**
 * Public business metadata from the business's own HTTPS homepage.
 *
 * OutreachGraph's public directory intentionally omits contact details.
 * We never treat its people records, guessed email addresses or CRM records
 * as public business contacts. An official homepage can explicitly publish a
 * generic business inbox, contact/team page, phone number and social profiles.
 * This parser does not fetch links, scrape individuals or guess addresses.
 */
import { normalizeDomain } from './listings.js'

export type CompanySiteMetadata = {
  contactUrl: string
  teamUrl: string
  email: string
  phone: string
  socialUrls: string[]
  sourceUrl: string
  checkedAt: number
}

export type CompanySiteFacts = Omit<CompanySiteMetadata, 'checkedAt'>

const ROLE_INBOX = /^(info|contact|hello|sales|support|office|enquiries|inquiries|press|media|pr|investors|investorrelations|ir|service|customerservice|business|general)([+._-][a-z0-9-]+)?$/i
const SOCIAL_HOSTS = new Set(['linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'youtube.com', 'bsky.app'])
const clean = (value: unknown, n: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : ''

function officialUrl(input: string, domain: string): string {
  try {
    const url = new URL(input, `https://${domain}/`)
    if (url.protocol !== 'https:' || normalizeDomain(url.hostname) !== domain || url.username || url.password) return ''
    url.hash = ''
    return url.href.slice(0, 300)
  } catch { return '' }
}

function businessEmail(raw: string, domain: string): string {
  const match = /^mailto:([^?#]+)/i.exec(raw.trim())
  if (!match) return ''
  let email = ''
  try { email = decodeURIComponent(match[1]!) } catch { return '' }
  const at = email.lastIndexOf('@')
  if (at < 1 || normalizeDomain(email.slice(at + 1)) !== domain) return ''
  const local = email.slice(0, at)
  return ROLE_INBOX.test(local) ? email.slice(0, 120) : ''
}

function socialUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (url.protocol !== 'https:' || !SOCIAL_HOSTS.has(host) || url.username || url.password) return ''
    if (url.pathname === '/' || url.pathname.length < 3) return ''
    if (host === 'linkedin.com' && !/^\/(company|school)\//.test(url.pathname)) return ''
    url.hash = ''
    url.search = ''
    return url.href.slice(0, 300)
  } catch { return '' }
}

function jsonLdOrganization(html: string, domain: string): { phone: string; email: string } {
  const matches = html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)
  for (const match of matches) {
    if (!match[1] || match[1].length > 32_000) continue
    let parsed: unknown
    try { parsed = JSON.parse(match[1]) } catch { continue }
    const nodes = [parsed]
    while (nodes.length) {
      const node = nodes.shift()
      if (Array.isArray(node)) { nodes.push(...node.slice(0, 30)); continue }
      if (!node || typeof node !== 'object') continue
      const row = node as Record<string, unknown>
      if (Array.isArray(row['@graph'])) nodes.push(...row['@graph'].slice(0, 30))
      const kinds = Array.isArray(row['@type']) ? row['@type'] : [row['@type']]
      if (!kinds.some(k => ['Organization', 'Corporation', 'LocalBusiness'].includes(String(k)))) continue
      if (typeof row.url !== 'string' || !officialUrl(row.url, domain)) continue
      const phone = clean(row.telephone, 40)
      const email = businessEmail(`mailto:${String(row.email ?? '')}`, domain)
      return { phone: /^[+\d ()-.]{7,40}$/.test(phone) ? phone : '', email }
    }
  }
  return { phone: '', email: '' }
}

export function parseCompanyHomepage(html: string, input: string): CompanySiteFacts | null {
  const domain = normalizeDomain(input)
  if (!domain) return null
  const sourceUrl = `https://${domain}/`
  let contactUrl = '', teamUrl = '', email = ''
  const socialUrls: string[] = []
  const links = html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)
  for (const match of links) {
    const raw = match[1] ?? ''
    if (!email) email = businessEmail(raw, domain)
    const official = officialUrl(raw, domain)
    if (official) {
      const pathname = new URL(official).pathname.toLowerCase().replace(/\/$/, '')
      if (!contactUrl && /^\/(contact|contact-us|get-in-touch|support|about\/contact)$/.test(pathname)) contactUrl = official
      if (!teamUrl && /^\/(team|our-team|leadership|about\/team|about\/leadership|people)$/.test(pathname)) teamUrl = official
    }
    const social = socialUrl(raw)
    if (social && !socialUrls.includes(social) && socialUrls.length < 8) socialUrls.push(social)
  }
  const org = jsonLdOrganization(html, domain)
  return { contactUrl, teamUrl, email: email || org.email, phone: org.phone, socialUrls, sourceUrl }
}
