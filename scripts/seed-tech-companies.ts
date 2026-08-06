/**
 * Seed tech companies into the discovery pipeline.
 *
 * WHY: `discover-companies --phase=discover` mines company names out of
 * `job_postings` — i.e. companies we already ingest — and the Wikipedia seed is
 * disabled (0% yield). That makes discovery a closed loop: it can only find
 * more of what the feed already contains. Measured 2026-08-06, that left the
 * live feed ~20% tech, because ATS discovery naturally surfaces high-turnover
 * employers (drivers, ABA therapy, delivery, restaurants) that post far more
 * roles than stable engineering orgs.
 *
 * Reordering the probe backlog does NOT fix that (it moved 0.1% — the backlog is
 * residue whose source postings were long since purged). The only way to widen
 * tech supply is to introduce companies we have never seen. That is this script.
 *
 * Rows land as `discoverySource='seed'`, which ALREADY outranks apollo and
 * job_mining in probePendingCompanies()'s ORDER BY, so seeds get probed first
 * on the next run without any further change.
 *
 * We only supply NAMES. `probeCompany()` derives slug variants via
 * generateSlugs() and tests Greenhouse, Lever, Ashby, Workable, Recruitee,
 * SmartRecruiters and Breezy, so a company with no public board is simply
 * rejected. Nothing here asserts that a board exists.
 *
 * Existing rows are left completely untouched (onConflictDoNothing) — this must
 * never reset an already-approved or already-rejected company back to pending.
 *
 * Usage:
 *   npx tsx scripts/seed-tech-companies.ts [--dry-run]
 */

import { db, client } from '../server/db.js';
import { discoveredCompanies } from '../shared/schema.js';

/**
 * Curated tech employers likely to run a public ATS board.
 *
 * Deliberately excludes very generic single-word names (Public, Unit, Column,
 * Circle, Ghost, Medium, Arc...). Their slugs collide with unrelated boards, and
 * a false positive here is worse than a miss: it would ingest another company's
 * jobs under the wrong employer name.
 */
const TECH_COMPANIES: string[] = [
  // Dev tools / infrastructure
  'Vercel', 'Netlify', 'Supabase', 'PlanetScale', 'Neon', 'Render', 'Fly.io',
  'Railway', 'Grafana Labs', 'Chronosphere', 'Honeycomb', 'Sentry', 'CircleCI',
  'Buildkite', 'Harness', 'JFrog', 'Docker', 'Pulumi', 'Temporal Technologies',
  'Airbyte', 'dbt Labs', 'Fivetran', 'Prefect', 'Dagster Labs', 'Astronomer',
  'Starburst', 'ClickHouse', 'Timescale', 'SingleStore', 'Yugabyte', 'MongoDB',
  'Elastic', 'Gitpod', 'Sourcegraph', 'Linear', 'Replicated', 'Vantage',

  // AI / ML
  'OpenAI', 'Anthropic', 'Cohere', 'Hugging Face', 'Runway', 'Perplexity',
  'Character AI', 'Mistral AI', 'Together AI', 'Replicate', 'Weights and Biases',
  'Modal Labs', 'Anyscale', 'LangChain', 'Pinecone', 'Weaviate', 'Baseten',
  'Fireworks AI', 'Groq', 'Cerebras', 'SambaNova', 'Lambda Labs', 'Surge AI',
  'Labelbox', 'Snorkel AI', 'Abridge', 'Harvey', 'Glean', 'Sierra AI',
  'Decagon', 'Cresta', 'Adept AI',

  // Fintech
  'Modern Treasury', 'Marqeta', 'Chime', 'Affirm', 'Klarna', 'Wise', 'Revolut',
  'Monzo', 'Starling Bank', 'Nubank', 'SoFi', 'Betterment', 'Wealthfront',
  'Alpaca', 'Anchorage Digital', 'Fireblocks', 'Chainalysis', 'TRM Labs',
  'Alloy', 'Persona', 'Middesk', 'Plaid', 'Kraken Digital Asset Exchange',

  // Security
  'Wiz', 'Orca Security', 'Lacework', 'Aqua Security', 'Sysdig', 'Tailscale',
  '1Password', 'Okta', 'JumpCloud', 'Abnormal Security', 'Material Security',
  'Vanta', 'Drata', 'Secureframe', 'Semgrep', 'Chainguard', 'Netskope',
  'Arctic Wolf', 'Huntress', 'Dragos', 'Claroty', 'Snyk',

  // Data / analytics
  'Mixpanel', 'Heap', 'PostHog', 'Hex Technologies', 'Mode Analytics',
  'Sigma Computing', 'Census', 'Hightouch', 'RudderStack', 'Metabase',
  'Atlan', 'Monte Carlo Data', 'Bigeye', 'Secoda', 'Omni Analytics',

  // B2B SaaS
  'Monday.com', 'ClickUp', 'Smartsheet', 'Mural', 'Coda', 'Zendesk',
  'Freshworks', 'Gong', 'Outreach', 'Salesloft', 'Apollo.io', 'Pipedrive',
  'HubSpot', 'Klaviyo', 'Braze', 'Iterable', 'Customer.io', 'OneSignal',
  'Bandwidth', 'Sinch', 'Workato', 'Merge API', 'Attio',

  // HR tech / recruiting infrastructure
  'Remote.com', 'Oyster HR', 'Justworks', 'TriNet', 'Lattice', 'Culture Amp',
  '15Five', 'Greenhouse Software', 'Lever', 'Ashby', 'Workable',
  'SmartRecruiters', 'Checkr',

  // Health tech / bio
  'Oscar Health', 'Devoted Health', 'Included Health', 'Carbon Health', 'Ro',
  'Hims and Hers', 'Cedar', 'Zocdoc', 'Komodo Health', 'Tempus',
  'Flatiron Health', 'Recursion Pharmaceuticals', 'Insitro', 'Verily',
  'Color Health', 'Grail', 'Freenome', 'Truveta', 'Datavant', 'Notable Health',

  // Consumer / marketplace
  'DoorDash', 'Faire', 'Whatnot', 'StockX', 'GOAT Group', 'Poshmark', 'ThredUp',
  'Etsy', 'Shopify', 'BigCommerce', 'Squarespace', 'Wix', 'Framer', 'Calm',
  'Headspace', 'Strava', 'Whoop', 'Oura', 'Peloton', 'Patreon', 'Substack',
  'Cameo', 'Bumble', 'Hinge', 'Vimeo',

  // Gaming / media
  'Reddit', 'Pinterest', 'Snap', 'Roblox', 'Unity Technologies', 'Epic Games',
  'Riot Games', 'Niantic', 'Scopely', 'AppLovin',

  // Mobility / space / defense / climate
  'Project44', 'FourKites', 'Samsara', 'Motive', 'Nuro', 'Zoox',
  'Aurora Innovation', 'Waymo', 'Rivian', 'Lucid Motors', 'Joby Aviation',
  'Archer Aviation', 'Shield AI', 'Skydio', 'Applied Intuition', 'Astranis',
  'Relativity Space', 'Varda Space Industries', 'Commonwealth Fusion Systems',
  'Helion Energy', 'Form Energy', 'Redwood Materials', 'Sila Nanotechnologies',
  'Charm Industrial', 'Watershed', 'Persefoni', 'Stord',

  // Observability / enterprise infra
  'New Relic', 'Dynatrace', 'Splunk', 'Sumo Logic', 'Netdata',
];

/** Must match CompanyDiscoveryPipeline.normalizeCompanyName() exactly. */
function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/,?\s*(inc|llc|ltd|corp|corporation|co|company)\.?$/i, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

async function main(): Promise<void> {
  if (!db) { console.error('[SeedTech] Database not available'); process.exit(1); }
  const dryRun = process.argv.includes('--dry-run');

  const byName = new Map<string, string>();
  for (const name of TECH_COMPANIES) {
    const normalized = normalizeCompanyName(name);
    if (normalized) byName.set(normalized, name);
  }
  console.log(`[SeedTech] ${TECH_COMPANIES.length} names → ${byName.size} unique after normalization`);

  if (dryRun) {
    for (const [norm, name] of byName) console.log(`  ${name} → ${norm}`);
    return;
  }

  const rows = Array.from(byName, ([normalizedName, name]) => ({
    name,
    normalizedName,
    discoverySource: 'seed',
    status: 'pending',
    jobCount: 0,
    techScore: 0,
  }));

  const before = await db.$count(discoveredCompanies);
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(discoveredCompanies)
      .values(rows.slice(i, i + CHUNK))
      // Never touch an existing row: it may already be approved (and in the
      // scraper) or rejected, and resetting it to pending would re-probe it
      // forever.
      .onConflictDoNothing({ target: discoveredCompanies.normalizedName });
  }
  const after = await db.$count(discoveredCompanies);

  console.log(`[SeedTech] Inserted ${after - before} new companies (${rows.length - (after - before)} already known)`);
  console.log('[SeedTech] They queue as discoverySource=seed, which outranks apollo and job_mining in the probe order.');
}

main()
  .then(() => { client?.end(); process.exit(0); })
  .catch((err) => { console.error('[SeedTech] Fatal:', err); client?.end(); process.exit(1); });
