import type { Hono, Context } from 'hono'
import type { FeaturedBusinesses } from './business-featured.js'
import type { Listings } from './listings.js'
import { normalizeDomain } from './listings.js'
import { docPage, esc } from './html.js'

export function mountBusinessFeatured(app: Hono<any>, listings: Listings, billing: FeaturedBusinesses | undefined, limited: (c: any) => boolean, site = 'https://pit.world') {
  const render = (domain: string, message = '', details = '') => docPage({
    title: 'Feature your business · pit.world', path: domain ? `/b/${encodeURIComponent(domain)}/featured` : '/featured', noindex: Boolean(domain),
    description: 'Featured business placement on pit.world for $19 per month, paid through CoinPay. Free searchable listings remain available.',
    body: `<p class="kicker">Featured businesses · Paid placement</p><h1>Your business, easier to find.</h1>
<p class="lede">$19 per month for a clearly labeled featured listing on the pit.world directory and homepage. Category and location searches stay relevant to what your business actually does. No guaranteed leads, reviews or search-engine rankings.</p>
<p>Your searchable business listing stays free. Paid placement does not buy a verified-owner badge or change a license record.</p>
${message ? `<p class="notice" role="status">${esc(message)}</p>` : ''}${details}
${domain ? `<p><a href="/b/${encodeURIComponent(domain)}">View ${esc(domain)}</a> · <a href="/b/${encodeURIComponent(domain)}#claim">Claim this listing</a></p>
${billing ? `<form class="listing-edit" method="post" action="/b/${encodeURIComponent(domain)}/featured"><label for="feature-key">Listing edit key</label><input id="feature-key" name="key" type="password" required autocomplete="off"><p class="small">Only the verified owner can buy or manage featured placement. Your edit key is never put in a URL.</p><label for="feature-email">Invoice email</label><input id="feature-email" name="email" type="email" autocomplete="email" maxlength="254"><label class="check"><input name="consent" type="checkbox" value="monthly"> I want a $19 invoice each month. Placement runs only for paid months. I can stop future invoices below.</label><button class="btn" name="action" value="start">Open $19 CoinPay invoice</button><h2>Manage your plan</h2><p class="small">Use the same edit key. No email or checkbox is needed for these controls. Stopping renewal keeps the time already paid for and stops future invoices; an existing invoice is not an automatic charge.</p><div class="row"><button class="btn" name="action" value="status">Check status</button><button class="btn" name="action" value="cancel">Stop future invoices</button><button class="btn" name="action" value="resume">Resume monthly invoices</button></div></form>` : '<p>Featured checkout is temporarily unavailable. Your free listing and search remain available.</p>'}` : `<form class="listing-lookup" action="/featured" method="get"><input name="domain" type="text" required maxlength="253" placeholder="yourbusiness.com" aria-label="Business website"><button class="btn">Choose your business</button></form><p>Prove you own the domain with a DNS record or homepage tag, then use the listing edit key to open checkout.</p>`}
<p class="small">CoinPay invoices are issued through pay.agent. Each paid invoice buys one calendar month. The first placement appears after server-side payment confirmation, usually within a few minutes. Crypto payments require you to pay each invoice; this plan does not automatically withdraw from your wallet. Renewal invoices are sent up to three days before the paid period ends.</p>`,
  })
  const send = (c: Context, domain: string, message = '', details = '', status = 200) => {
    c.header('cache-control','no-store')
    return c.html(render(domain,message,details), status as 200)
  }
  app.get('/featured', c => {
    const domain = normalizeDomain(c.req.query('domain'))
    return domain ? c.redirect(`/b/${encodeURIComponent(domain)}/featured`,302) : send(c,'')
  })
  app.get('/b/:domain/featured', c => {
    const domain = normalizeDomain(c.req.param('domain'))
    return domain ? send(c,domain) : c.notFound()
  })
  app.post('/b/:domain/featured', async c => {
    const domain = normalizeDomain(c.req.param('domain'))
    if (!domain) return c.notFound()
    if (!billing) return send(c,domain,'Checkout is temporarily unavailable. Please try again later.','',503)
    if (limited(c)) return send(c,domain,'Too many requests. Please try again shortly.','',429)
    // No ambient authentication: every mutation requires the listing's secret edit key.
    const origin = c.req.header('origin')
    if (c.req.header('sec-fetch-site') === 'cross-site' || (origin && origin !== new URL(site).origin)) return send(c,domain,'Open this form on pit.world before submitting.','',403)
    const body = await c.req.parseBody().catch(()=>({})) as Record<string,unknown>
    if (!listings.authorized(domain,body.key)) return send(c,domain,'Use the edit key for this verified listing. Claim it first if you have not already.','',403)
    try {
      if (body.action === 'start') {
        if (body.consent !== 'monthly') return send(c,domain,'Select the monthly-invoice agreement before opening checkout.','',400)
        return c.redirect(await billing.start(domain,body.key,body.email),303)
      }
      if (body.action === 'cancel' || body.action === 'resume') billing.manage(domain,body.key,body.action === 'resume')
      else if (body.action !== 'status') return send(c,domain,'Choose a plan action.','',400)
      const state = billing.status(domain)
      return send(c,domain,body.action === 'cancel' ? 'Future monthly invoices stopped. Your paid time stays active.' : body.action === 'resume' ? 'Monthly invoices resumed.' : 'Plan status checked.',`<p>Featured placement: <strong>${state.activeUntil ? `paid through ${esc(new Date(state.activeUntil).toISOString().slice(0,10))} UTC` : 'not active'}</strong>. Future monthly invoices: <strong>${state.renew ? 'on' : 'off'}</strong>.</p>`)
    } catch(error) { return send(c,domain,error instanceof Error ? error.message : 'Unable to update the plan.','',400) }
  })
}
