/**
 * A new bbs.<name>.pit.world board: its forums, settings and administrators.
 * Runs once, inside the board's container (pit-bbs-provision copies it in):
 *   docker exec -e PIT_NAME=family.ancestry -e PIT_ADMIN_SUBS=did:key:... pit-bbs-family.ancestry bun /app/data/pit-seed.ts
 *
 * The administrators are the pit.world admins, linked by their CoinPay DID through
 * tsbb's own bridge code, so they are accounts #1.. and nobody who wanders in first
 * becomes the board's owner. They sign in with their pit.world account as anyone does.
 */
const ROOT = process.env.TSBB_CHECKOUT_DIR ?? '/app'
const { migrate } = await import(`${ROOT}/packages/db/src/migrate.ts`)
const { one, run, now } = await import(`${ROOT}/packages/db/src/client.ts`)
const { seed } = await import(`${ROOT}/packages/db/src/seed.ts`)
const { bridgeAccount } = await import(`${ROOT}/packages/core/src/bridge.ts`)

const name = String(process.env.PIT_NAME ?? '')
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) throw new Error('PIT_NAME must be a Moshpit name')
const admins = String(process.env.PIT_ADMIN_SUBS ?? '').split(',').map((s) => s.trim()).filter(Boolean)

await migrate(undefined, { quiet: true })

for (const [i, sub] of admins.entries()) {
  const user = await bridgeAccount('bridge', { sub, username: i === 0 ? 'admin' : `admin${i + 1}`, name: 'pit.world admin' })
  await run('UPDATE users SET is_admin = 1 WHERE id = ?', [user.id])
  console.log(`  admin ${sub.slice(0, 24)}… is user ${user.id}`)
}

const TREE = [
  {
    slug: 'board',
    name,
    forums: [
      { slug: 'announcements', name: 'Announcements', description: `News about ${name}.` },
      { slug: 'introductions', name: 'Introductions', description: 'New here? Say hello.' },
      { slug: 'general', name: 'General', description: `Anything about ${name}.` },
    ],
  },
  {
    slug: 'community',
    name: 'Community',
    forums: [
      { slug: 'help', name: 'Help & Questions', description: 'Ask, and someone who has been there answers.' },
      { slug: 'show-and-tell', name: 'Show & Tell', description: 'Share what you made or found.' },
      { slug: 'off-topic', name: 'Off Topic', description: 'Everything else.' },
    ],
  },
]

async function upsertForum(parentId: number | null, kind: string, slug: string, title: string, description: string | null, position: number) {
  const existing = await one<{ id: number }>('SELECT id FROM forums WHERE slug = ?', [slug])
  if (existing) return Number(existing.id)
  const result = await run('INSERT INTO forums (parent_id, kind, slug, name, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id', [parentId, kind, slug, title, description, position, now()])
  return Number((result.rows[0] as unknown as { id: number }).id)
}
for (const [c, category] of TREE.entries()) {
  const parent = await upsertForum(null, 'category', category.slug, category.name, null, c)
  for (const [f, forum] of category.forums.entries()) await upsertForum(parent, 'forum', forum.slug, forum.name, forum.description, f)
}

const SETTINGS: Record<string, unknown> = {
  'board.name': name,
  'board.tagline': `The ${name} board`,
  'board.description': `The community board for ${name}, on the Moshpit network. Sign in with your pit.world account: one account for every pit.world board and social feed.`,
  'board.showPlatform': false,
  'board.navLinks': [`${name} | https://${name}.pit.world/`, `Social | https://social.${name}.pit.world/`, 'Board | {forums}', 'Your pit.world account | https://pit.world/account | button'].join('\n'),
}
for (const [key, value] of Object.entries(SETTINGS)) {
  await run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, JSON.stringify(value), now()])
}
await seed({ quiet: true })
console.log(`  ${name}: forums, settings, ${admins.length} admin(s)`)
process.exit(0)
