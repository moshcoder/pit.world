/** The promotion tables (src/promotion.ts), created with listings.db so the directory can order by membership in SQL. No imports: listings.ts loads this. */
import type { Database } from 'bun:sqlite'

/** Created with the listings table, so the directory can order by membership in SQL. */
export function ensurePromotionSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS promo_campaigns (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft',
    config TEXT NOT NULL DEFAULT '{}', launched_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  db.run(`CREATE TABLE IF NOT EXISTS promo_imports (
    id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, snapshot_at TEXT NOT NULL, complete INTEGER NOT NULL, checksum TEXT NOT NULL,
    rows_total INTEGER NOT NULL, totals TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (campaign_id, checksum))`)
  db.run(`CREATE TABLE IF NOT EXISTS promo_import_rows (
    import_id TEXT NOT NULL, row_index INTEGER NOT NULL, lead_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', domain TEXT,
    disposition TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', PRIMARY KEY (import_id, row_index))`)
  db.run(`CREATE TABLE IF NOT EXISTS promo_members (
    campaign_id TEXT NOT NULL, domain TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', priority INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER, hold TEXT NOT NULL DEFAULT 'unknown', hold_detail TEXT NOT NULL DEFAULT '', verification TEXT NOT NULL DEFAULT '{}',
    tracking_tested_at INTEGER, prior_contact TEXT NOT NULL DEFAULT '', joined_at INTEGER NOT NULL, left_at INTEGER, updated_at INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, domain))`)
  db.run(`CREATE TABLE IF NOT EXISTS promo_leads (
    campaign_id TEXT NOT NULL, lead_id TEXT NOT NULL, domain TEXT, name TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '',
    emails TEXT NOT NULL DEFAULT '[]', suppressed INTEGER NOT NULL DEFAULT 0, contacts_out INTEGER NOT NULL DEFAULT 0, contacts_in INTEGER NOT NULL DEFAULT 0,
    last_contact_at TEXT, upstream TEXT NOT NULL DEFAULT '[]', source_order INTEGER, seen_import TEXT, PRIMARY KEY (campaign_id, lead_id))`)
  db.run(`CREATE TABLE IF NOT EXISTS promo_exclusions (campaign_id TEXT NOT NULL, subject TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (campaign_id, subject))`)
  db.run(`CREATE TABLE IF NOT EXISTS promo_placements (
    id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, kind TEXT NOT NULL, channel TEXT NOT NULL, account TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '', content_version TEXT NOT NULL DEFAULT '', planned_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'ready',
    provider_id TEXT NOT NULL DEFAULT '', public_url TEXT NOT NULL DEFAULT '', queue_id TEXT NOT NULL DEFAULT '', published_at INTEGER, verified_at INTEGER,
    evidence TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until INTEGER, error TEXT NOT NULL DEFAULT '',
    paid INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  db.run('CREATE INDEX IF NOT EXISTS promo_placements_due ON promo_placements (campaign_id, state, planned_at)')
  db.run('CREATE TABLE IF NOT EXISTS promo_placement_members (placement_id TEXT NOT NULL, domain TEXT NOT NULL, PRIMARY KEY (placement_id, domain))')
  db.run(`CREATE TABLE IF NOT EXISTS promo_events (
    id TEXT PRIMARY KEY, at INTEGER NOT NULL, type TEXT NOT NULL, domain TEXT, campaign_id TEXT, placement_id TEXT, source TEXT NOT NULL DEFAULT '',
    test INTEGER NOT NULL DEFAULT 0, excluded TEXT NOT NULL DEFAULT '', visitor TEXT NOT NULL DEFAULT '')`)
  db.run('CREATE INDEX IF NOT EXISTS promo_events_domain_at ON promo_events (domain, at)')
  db.run('CREATE INDEX IF NOT EXISTS promo_events_campaign_at ON promo_events (campaign_id, at)')
  db.run('CREATE TABLE IF NOT EXISTS promo_salts (day TEXT PRIMARY KEY, salt TEXT NOT NULL)')
  db.run(`CREATE TABLE IF NOT EXISTS promo_periods (
    id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, domain TEXT NOT NULL, seq INTEGER NOT NULL, started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'active', start_evidence TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, UNIQUE (campaign_id, domain, seq))`)
  db.run('CREATE TABLE IF NOT EXISTS promo_gaps (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, domain TEXT, kind TEXT NOT NULL, from_at INTEGER NOT NULL, to_at INTEGER, note TEXT NOT NULL DEFAULT \'\')')
  db.run(`CREATE TABLE IF NOT EXISTS promo_reports (
    id TEXT PRIMARY KEY, period_id TEXT NOT NULL, campaign_id TEXT NOT NULL, domain TEXT NOT NULL, version INTEGER NOT NULL, generated_at INTEGER NOT NULL,
    cutoff INTEGER NOT NULL, rules_version TEXT NOT NULL, data TEXT NOT NULL, digest TEXT NOT NULL, share_token TEXT NOT NULL, superseded_at INTEGER,
    UNIQUE (period_id, version))`)
  db.run(`CREATE TABLE IF NOT EXISTS promo_drafts (
    id TEXT PRIMARY KEY, report_id TEXT NOT NULL, campaign_id TEXT NOT NULL, domain TEXT NOT NULL, kind TEXT NOT NULL, recipient_name TEXT NOT NULL DEFAULT '',
    recipient_email TEXT NOT NULL DEFAULT '', lead_id TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL, body TEXT NOT NULL, version TEXT NOT NULL,
    state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (report_id))`)
  db.run(`CREATE TABLE IF NOT EXISTS promo_deliveries (
    id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, recipient TEXT NOT NULL, message_version TEXT NOT NULL, period_id TEXT NOT NULL, state TEXT NOT NULL,
    provider_id TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, UNIQUE (recipient, message_version, period_id))`)
  db.run(`CREATE TABLE IF NOT EXISTS promo_spend (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, kind TEXT NOT NULL, cents INTEGER NOT NULL, state TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL)`)
  db.run(`CREATE TABLE IF NOT EXISTS promo_jobs (
    id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, campaign_id TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER, result TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
  db.run('CREATE TABLE IF NOT EXISTS promo_idempotency (key TEXT PRIMARY KEY, operation TEXT NOT NULL, response TEXT NOT NULL, at INTEGER NOT NULL)')
  db.run('CREATE TABLE IF NOT EXISTS promo_audit (at INTEGER NOT NULL, actor TEXT NOT NULL, campaign_id TEXT, action TEXT NOT NULL, subject TEXT NOT NULL DEFAULT \'\', detail TEXT NOT NULL DEFAULT \'{}\')')
}


