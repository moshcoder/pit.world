#!/usr/bin/env bash
# outreachgraph-campaign-export.sh: a complete, read-only snapshot of one OutreachGraph campaign's
# members, as the JSON `pit promo import` takes. OutreachGraph has no API that lists every member of
# a campaign (GET /campaigns/:id/accounts leaves out people without a company, and carries no
# addresses), so this reads its Postgres directly, in one SELECT: nothing is written.
#
#   scripts/outreachgraph-campaign-export.sh cmp_... > snapshot.json
#
# DATABASE_URL comes from the environment, else from OG_APP_ENV (default ~/www/outreachgraph.com/app.env,
# only its DATABASE_URL line). Runs psql inside the Supabase container on dev2 (PSQL_CONTAINER).
#
# Every member row carries what the promotion hold needs to be checked against the upstream state:
# the other campaigns the person is in and how each one sends, whether they are suppressed, and their
# contact history (interactions, by direction). Rows keep OutreachGraph's own order (discovered_at, id).
set -euo pipefail

CAMPAIGN="${1:?usage: $0 <campaign id>}"
[[ "$CAMPAIGN" =~ ^cmp_[a-z0-9]+$ ]] || { echo "not a campaign id: $CAMPAIGN" >&2; exit 2; }
CONTAINER="${PSQL_CONTAINER:-logicsrc-com-supabase-db}"
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL="$(grep '^DATABASE_URL=' "${OG_APP_ENV:-$HOME/www/outreachgraph.com/app.env}" | cut -d= -f2-)"
fi

docker exec -i "$CONTAINER" psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At -v campaign="$CAMPAIGN" <<'SQL'
WITH c AS (SELECT * FROM campaigns WHERE id = :'campaign'),
members AS (
  SELECT cp.*, row_number() OVER (ORDER BY cp.discovered_at, cp.person_id) AS ord
    FROM campaign_people cp JOIN c ON c.id = cp.campaign_id
)
SELECT json_build_object(
  'source', 'outreachgraph',
  'campaignId', (SELECT id FROM c),
  'campaignName', (SELECT name FROM c),
  'workspaceId', (SELECT workspace_id FROM c),
  'approvalMode', (SELECT approval_mode FROM c),
  'snapshotAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'complete', true,
  'total', (SELECT count(*) FROM members),
  'rows', COALESCE((SELECT json_agg(json_build_object(
      'leadId', m.person_id,
      'order', m.ord,
      'memberStatus', m.status,
      'interactionState', m.interaction_state,
      'name', p.display_name,
      'kind', p.kind,
      'personStatus', p.status,
      'title', p.current_title,
      'company', co.name,
      'companyId', co.id,
      'domain', co.domain,
      'location', COALESCE(co.location, p.location),
      'emails', COALESCE((SELECT json_agg(e.address ORDER BY e.address) FROM person_emails e WHERE e.person_id = p.id), '[]'::json),
      'socials', COALESCE((SELECT json_agg(json_build_object('network', s.network, 'url', s.profile_url)) FROM social_identities s WHERE s.person_id = p.id), '[]'::json),
      'suppressed', p.status = 'suppressed' OR m.status = 'suppressed' OR EXISTS (
          SELECT 1 FROM suppression_keys k
           WHERE k.match_key IN (SELECT 'person:' || p.id UNION SELECT 'email:' || lower(e.address) FROM person_emails e WHERE e.person_id = p.id)
             AND (k.scope = 'global' OR k.workspace_id = m.workspace_id)),
      'suppressLists', COALESCE((SELECT json_agg(DISTINCT se.name) FROM suppression_keys k JOIN suppression_entries se ON se.id = k.suppression_id
           WHERE se.name IS NOT NULL AND (k.scope = 'global' OR k.workspace_id = m.workspace_id)
             AND k.match_key IN (SELECT 'person:' || p.id UNION SELECT 'email:' || lower(e.address) FROM person_emails e WHERE e.person_id = p.id)), '[]'::json),
      'campaigns', COALESCE((SELECT json_agg(json_build_object('id', oc.id, 'name', oc.name, 'approvalMode', oc.approval_mode, 'status', oc.status, 'memberStatus', ocp.status))
           FROM campaign_people ocp JOIN campaigns oc ON oc.id = ocp.campaign_id WHERE ocp.person_id = p.id), '[]'::json),
      'contacts', json_build_object(
          'outbound', (SELECT count(*) FROM interactions i WHERE i.person_id = p.id AND i.direction = 'outbound'),
          'inbound', (SELECT count(*) FROM interactions i WHERE i.person_id = p.id AND i.direction = 'inbound'),
          'lastAt', (SELECT max(i.occurred_at) FROM interactions i WHERE i.person_id = p.id)),
      'discoveredAt', m.discovered_at
    ) ORDER BY m.ord)
    FROM members m JOIN people p ON p.id = m.person_id LEFT JOIN companies co ON co.id = p.current_company_id), '[]'::json)
);
SQL
