#!/usr/bin/env bun
/**
 * The /build A/B report from the host, straight from the store:
 *
 *   PIT_DATA_DIR=/var/lib/pit-world bun src/build-ab-cli.ts [--days N] [--json]
 *
 * Read-only (run it as any user who can read build-ab.db). Paid status is
 * checked against pay.agent by the admin endpoint instead
 * (GET /api/admin/build-ab.json), which can write.
 */
import { BuildAb, BUILD_TEST, formatReport } from './build-ab.js'

const args = process.argv.slice(2)
const at = args.indexOf('--days')
const days = at >= 0 ? Number(args[at + 1]) : 0
const path = process.env.PIT_BUILD_AB_DB ?? `${process.env.PIT_DATA_DIR ?? `${process.env.HOME ?? '.'}/.local/share/pit-world`}/build-ab.db`
const ab = new BuildAb(path, BUILD_TEST, Date.now, true)
const report = ab.report(days > 0 ? Date.now() - days * 86_400_000 : 0)
console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report))
