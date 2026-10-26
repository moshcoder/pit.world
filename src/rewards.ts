/**
 * Credit codes and invites on pit.world accounts.
 *
 * - **Credit codes** (@profullstack/redeem-credits) grant `server_months`: months of the
 *   $5-a-month Moshpit server sold on /start. A month is spent through the same order the
 *   paid path uses: the names to serve, a username and an SSH key go to whoever sets up
 *   servers (PIT_BUILD_NOTIFY), marked "paid with a credit" instead of "paid on pay.agent".
 *   Names under our own endings are already free, so a code is never worth a "name".
 * - **Invites** (@profullstack/affiliates) are scarce: 3 per account, single use, 30 days.
 *   An accepted invite gives nothing beyond itself: it records who brought whom.
 * - **Affiliate links** (`?ref=`) attribute a NEW account to the member who sent it, first
 *   touch, once. Promoter codes (src/promoters.ts) are a different program and are left to it.
 *
 * Both modules keep their tables in accounts.db (credit_*, aff_*), keyed by account id, so the
 * redeem-credits CLI can mint against that file. Nothing here sets a cookie: the invite and the
 * ref ride the sign-in `next` URL, as the promoter program's ref does.
 */
import type { Database } from 'bun:sqlite'
import { Credits, sqliteStore } from '@profullstack/redeem-credits'
import { Affiliates, sqliteStore as affiliateStore } from '@profullstack/affiliates'
import { isNameShape, type Account } from './accounts.js'
import type { Mailer } from './newsletter.js'

/** The unit a credit code grants: one = one month of a Moshpit server. */
export const SERVER_MONTHS = 'server_months'
/** What a month costs on /start. */
export const SERVER_USD = 5
/** Invites each account can hand out. Scarce on purpose: an invite should mean something. */
export const INVITES_PER_ACCOUNT = 3

export type RewardsOptions = {
  mailer?: Mailer | null
  /** Who sets up Moshpit servers (the same address /build orders go to). */
  notifyTo?: string
  /** Codes that belong to the promoter program, so ?ref= never attributes them twice. */
  promoterCode?: (code: string) => boolean
}

export type ServerOrder = { names: string[]; username: string; sshKey: string; note: string }

export class RewardError extends Error {}

const REDEEM_WHY: Record<string, string> = {
  invalid: 'That code is not valid.',
  expired: 'That code has expired.',
  used_up: 'That code has been used.',
  already_redeemed: 'You already redeemed that code.',
  revoked: 'That code was withdrawn.',
}
const INVITE_WHY: Record<string, string> = {
  invalid: 'That invite is not valid.',
  expired: 'That invite has expired.',
  used: 'That invite has already been used.',
  self: 'That is your own invite.',
  revoked: 'That invite was withdrawn.',
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Form fields to a server order, or the reason they are not one. */
export function readServerOrder(form: Record<string, unknown>): ServerOrder {
  const str = (k: string, max: number) => String(form[k] ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max)
  const names = [...new Set(str('names', 2000).toLowerCase().split(/[\s,]+/).filter(Boolean))]
  if (!names.length) throw new RewardError('Which Moshpit names should the server serve? (shop.yourname)')
  if (names.length > 20) throw new RewardError('Up to 20 names per order; ask us for more once it is running.')
  const bad = names.find((n) => !isNameShape(n))
  if (bad) throw new RewardError(`"${bad}" is not a Moshpit name (label.ending).`)
  const username = str('username', 32).toLowerCase()
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(username)) throw new RewardError('Pick a username: lowercase letters, digits and dashes, starting with a letter.')
  const sshKey = str('ssh_key', 4000).replace(/\s+/g, ' ')
  if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( \S.{0,200})?$/.test(sshKey))
    throw new RewardError('Paste your SSH public key (cat ~/.ssh/id_ed25519.pub): one line starting with ssh-ed25519 or ssh-rsa.')
  return { names, username, sshKey, note: str('note', 500) }
}

export class Rewards {
  readonly credits: Credits
  readonly affiliates: Affiliates

  constructor(
    db: Database,
    private opts: RewardsOptions = {},
  ) {
    this.credits = new Credits(sqliteStore(db as never))
    this.affiliates = new Affiliates(affiliateStore(db as never), {
      defaultQuota: INVITES_PER_ACCOUNT,
      ...(opts.promoterCode ? { externalCodes: (code: string) => opts.promoterCode!(code) } : {}),
    })
  }

  /** Server months this account can spend. */
  serverMonths(accountId: string): Promise<number> {
    return this.credits.balance(accountId, SERVER_MONTHS)
  }

  /** Whether a month can be turned into a server order here (someone hears about it). */
  get ordersOpen(): boolean {
    return Boolean(this.opts.mailer && this.opts.notifyTo)
  }

  /** Redeem a credit code; the message to show. Throws RewardError with a friendly reason. */
  async redeem(accountId: string, code: string): Promise<string> {
    if (!String(code ?? '').trim()) throw new RewardError('Type the code.')
    const r = await this.credits.redeem(code, accountId)
    if (!r.ok) throw new RewardError(REDEEM_WHY[r.reason] ?? 'That code did not work.')
    const g = r.grant
    const what = g.unit === SERVER_MONTHS ? `${plural(g.amount, 'month')} of a Moshpit server` : `${g.amount} ${g.unit}`
    return `Redeemed: ${what}${g.every === 'month' ? ' every month' : ''}.`
  }

  /**
   * Spend one month on a Moshpit server: the order goes to whoever sets servers up, exactly as a
   * month paid on pay.agent does. The month is spent first and given back if the order cannot be sent.
   */
  async orderServer(account: Account, order: ServerOrder): Promise<void> {
    if (!this.ordersOpen) throw new RewardError('Server orders are not open on this instance.')
    if ((await this.serverMonths(account.id)) < 1) throw new RewardError('You have no server months. Redeem a code first.')
    const spent = await this.credits.spend(account.id, SERVER_MONTHS, 1, `server ${order.username}: ${order.names.join(' ')}`)
    if (!spent.ok) throw new RewardError('You have no server months. Redeem a code first.')
    const text = [
      'New Moshpit server month, paid with a pit.world credit (not pay.agent).',
      '',
      `Account: ${account.name ?? '(no name)'} ${account.sub}${account.email ? ` <${account.email}>` : ''}`,
      `Names: ${order.names.join(' ')}`,
      `Username: ${order.username}`,
      `SSH key: ${order.sshKey}`,
      ...(order.note ? ['', `Note: ${order.note}`] : []),
      '',
      `Set it up as for a $${SERVER_USD} month paid on pay.agent: account on the Moshpit server, each name pointed at it with its certificate, then reply.`,
    ].join('\n')
    try {
      await this.opts.mailer!({
        to: this.opts.notifyTo!,
        subject: `Moshpit server (credit): ${order.username} ${order.names[0]}`,
        text,
        html: `<pre>${text.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!)}</pre>`,
        ...(account.email ? { replyTo: account.email } : {}),
      })
    } catch (e) {
      await this.credits.grant(account.id, { unit: SERVER_MONTHS, amount: 1 }, 'refund: server order email failed')
      console.error('server order email:', e instanceof Error ? e.message : e)
      throw new RewardError('The order did not go through, and your month is back. Try again in a minute.')
    }
  }

  /** A new account signed in through an invite: spend it. Gives nothing beyond the invite itself. */
  async acceptInvite(code: string, accountId: string): Promise<{ ok: boolean; message: string; inviterId?: string }> {
    const r = await this.affiliates.redeemInvite(code, accountId)
    if (!r.ok) return { ok: false, message: INVITE_WHY[r.reason] ?? 'That invite did not work.' }
    return { ok: true, message: 'Invite accepted. Welcome in.', inviterId: r.inviterId }
  }

  /** First-touch attribution of a new account to the member whose affiliate link brought it. */
  async attribute(ref: string, accountId: string): Promise<boolean> {
    const r = await this.affiliates.attribute(ref, accountId)
    return r.ok
  }

  /** What a signed-in person sees on /account/invites and from the API. */
  async invitesOf(accountId: string, site: string) {
    const [quota, invites, invitees, code] = await Promise.all([
      this.affiliates.quota(accountId),
      this.affiliates.invites(accountId),
      this.affiliates.invitees(accountId),
      this.affiliates.affiliateCode(accountId),
    ])
    return { quota, invites, joined: invitees.length, affiliateLink: `${site}/join?ref=${code}` }
  }

  async createInvite(accountId: string, note: string, site: string): Promise<{ code: string; link: string; expiresAt: number | null; left: number }> {
    try {
      const invite = await this.affiliates.createInvite(accountId, note.slice(0, 80))
      return { code: invite.code, link: `${site}/i/${invite.code}`, expiresAt: invite.expiresAt, left: (await this.affiliates.quota(accountId)).left }
    } catch (e) {
      throw new RewardError(e instanceof Error && e.message === 'no invites left' ? 'You have used all your invites.' : 'Could not make an invite.')
    }
  }
}
