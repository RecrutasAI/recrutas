#!/usr/bin/env node
// CI security gate: fail on high/critical npm advisories, except ones listed
// below with a reason and a review date.
//
// Why not plain `npm audit --audit-level=high`: it has no way to ignore an
// advisory, so one unfixable advisory (no patched version published) turns
// every push red and the gate stops meaning anything. Allowlisting by GHSA id
// keeps it meaningful: any NEW high advisory still fails the build, and an
// entry past its reviewBy date fails too, so nothing stays ignored forever.
import { execSync } from 'node:child_process';

const ALLOWLIST = {
  'GHSA-vfj7-8cjw-p6xm': {
    package: 'braces',
    reason:
      'No patched version exists (affects <=3.0.3, the latest). Only reached via ' +
      'build/dev tooling (tailwindcss -> micromatch/chokidar, nodemon, jest); no ' +
      'user input reaches a glob pattern at runtime.',
    reviewBy: '2026-11-03',
  },
  // tinypool: both advisories need tinypool >= 2.1.2, which only vitest 4
  // brings (a major upgrade of the test runner). Test-only: tinypool runs our
  // own test workers in CI and dev, never in production, and its options come
  // from our config, not user input.
  'GHSA-5gmw-xhrv-c9v3': {
    package: 'tinypool',
    reason: 'Test runner only (vitest 3 -> tinypool 1.x); fix needs vitest 4. Never shipped; worker options come from our own config.',
    reviewBy: '2026-11-07',
  },
  'GHSA-85c8-ppgw-ccpr': {
    package: 'tinypool',
    reason: 'Test runner only (vitest 3 -> tinypool 1.x); fix needs vitest 4. Never shipped; run() options come from our own config.',
    reviewBy: '2026-11-07',
  },
};

const BLOCKING = new Set(['high', 'critical']);

let raw;
try {
  raw = execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  // npm audit exits non-zero whenever it finds anything; the JSON is still on stdout.
  raw = err.stdout;
}
if (!raw) {
  console.error('npm audit produced no output');
  process.exit(1);
}

const report = JSON.parse(raw);
if (report.error) {
  console.error('npm audit failed:', report.error.summary ?? report.error);
  process.exit(1);
}

// Root advisories are the object entries in `via`; string entries just point
// at another vulnerable package, so they're covered by its advisory.
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via === 'object') advisories.set(via.url, via);
  }
}

const today = new Date().toISOString().slice(0, 10);
let failed = false;

for (const adv of advisories.values()) {
  if (!BLOCKING.has(adv.severity)) continue;
  const id = adv.url.split('/').pop();
  const entry = ALLOWLIST[id];
  if (!entry) {
    console.error(`❌ ${adv.severity} ${adv.name} ${adv.range}: ${adv.title}\n   ${adv.url}`);
    failed = true;
  } else if (entry.reviewBy < today) {
    console.error(`❌ allowlist entry ${id} (${entry.package}) expired ${entry.reviewBy}; re-check and renew or remove it`);
    failed = true;
  } else {
    console.log(`⚠️  allowed until ${entry.reviewBy}: ${adv.severity} ${adv.name} (${id}): ${entry.reason}`);
  }
}

for (const id of Object.keys(ALLOWLIST)) {
  if (![...advisories.values()].some((a) => a.url.endsWith(id))) {
    console.log(`ℹ️  allowlist entry ${id} no longer matches anything; remove it`);
  }
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log(`npm audit: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate`);
process.exit(failed ? 1 : 0);
