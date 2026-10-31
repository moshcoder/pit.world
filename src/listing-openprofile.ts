/**
 * A directory listing as an OpenProfile.md (https://logicsrc.com/openprofile), Kind organization, so other
 * apps can read a business from pit.world the way they read a person: /b/<domain>/openprofile.md, found
 * through <link rel="openprofile"> on the listing page and a Link header.
 *
 * Only what the listing page already shows. Never the private quote address (a Listing has none), and an
 * unclaimed listing says so: it is pit.world's claim from public records until the owner takes it over.
 */
import { keyedSection, listSection, makeOpenProfile, renderOpenProfile } from '@profullstack/openprofile'
import { place, siteUrl } from './listings-html.js'
import type { Listing } from './listings.js'
import { categoryOf, operatorHref, priceLabel } from './pros.js'

const SITE = 'https://pit.world'

export const openProfilePath = (domain: string) => `/b/${encodeURIComponent(domain)}/openprofile.md`
export const openProfileUrl = (domain: string) => `${SITE}${openProfilePath(domain)}`

export function listingOpenProfile(l: Listing): string {
  const page = `${SITE}/b/${encodeURIComponent(l.domain)}`
  const category = categoryOf(l.category)?.label ?? ''
  const site = siteUrl(l)
  const meta = l.publicMetadata
  const links = [...new Set([site, ...l.links, ...(meta?.contactUrl ? [meta.contactUrl] : []), ...(meta?.teamUrl ? [meta.teamUrl] : []), ...(meta?.socialUrls ?? []), ...(l.feed ? [l.feed] : [])])]
  return renderOpenProfile(
    makeOpenProfile({
      name: l.name || l.domain,
      identity: {
        Kind: 'organization',
        Web: site,
        Category: category || null,
        Location: place(l) || null,
        Area: l.area || null,
        Address: l.address || null,
        Phone: l.phone || meta?.phone || null,
        PublicBusinessEmail: meta?.email || null,
        BusinessContactPage: meta?.contactUrl || null,
        PublicBusinessSource: meta?.sourceUrl || null,
        Hours: l.hours || null,
        Price: l.price ? priceLabel(l.price) : null,
        License: l.license
          ? `${l.license}${l.licenseCheckedAt ? ` (active when pit.world checked on ${new Date(l.licenseCheckedAt).toISOString().slice(0, 10)})` : ''}`
          : null,
        Moshpit: l.moshpit || null,
        Parent: l.company ? (l.companyUrl ? `[${l.company}](${l.companyUrl})` : l.company) : l.companyUrl || null,
        Listing: page,
        Status: l.claimed ? 'claimed by the owner' : 'listed by pit.world from public records, unclaimed',
      },
      headline: l.description || null,
      sections: [
        listSection('Links', links),
        listSection('Topics', [category]),
        listSection('Services', l.services),
        listSection('Public company topics', l.researchTopics),
        l.operator
          ? keyedSection('Operator', operatorHref(l.operator) ? { Profile: l.operator } : { Name: l.operator })
          : null,
      ],
    }),
  )
}
