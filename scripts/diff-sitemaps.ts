import fs from 'fs';
import path from 'path';
import { CompetitorsData, SitemapDiff, SitemapEntry, SitemapFetchFailure } from '../lib/types';

const ROOT = process.cwd();
const TODAY = new Date().toISOString().split('T')[0];

function listSnapshotDates(): string[] {
  const dir = path.join(ROOT, 'data', 'sitemaps');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

interface LoadedSnapshot {
  entries: SitemapEntry[] | null;
  fetchError: string | null;
  sourceUrl: string | null;
}

// entries is null when there is genuinely nothing usable (no file, or the fetch
// failed). Returning [] in the failure case would make the diff report every
// known URL as removed.
function loadSnapshot(date: string, competitorId: string): LoadedSnapshot {
  const p = path.join(ROOT, 'data', 'sitemaps', date, `${competitorId}.json`);
  if (!fs.existsSync(p)) return { entries: null, fetchError: null, sourceUrl: null };
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (raw.fetchError) {
    return { entries: null, fetchError: raw.fetchError, sourceUrl: raw.sourceUrl || null };
  }
  return { entries: raw.entries || [], fetchError: null, sourceUrl: raw.sourceUrl || null };
}

const NOISE_PATTERNS = [
  /\/products\//i,
  /\/product\//i,
  /\/collections\/[a-z0-9-]+\/products\//i,
  /\/listing\//i,
  /\/watch\/[a-z0-9-]+\/[a-z0-9-]+/i,
  /\/watches\/[a-z0-9-]+\/[a-z0-9-]+/i,
  /\/sku\//i,
  /\/ref-[a-z0-9-]+/i,
  /\?/,
];

function isNoise(url: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(url));
}

function diff(
  competitorId: string,
  prev: SitemapEntry[] | null,
  curr: SitemapEntry[]
): SitemapDiff {
  if (!prev) {
    return {
      competitorId,
      newUrls: curr.filter((e) => !isNoise(e.url)),
      removedUrls: [],
      updatedUrls: [],
    };
  }
  const prevMap = new Map(prev.map((e) => [e.url, e]));
  const currMap = new Map(curr.map((e) => [e.url, e]));

  const newUrls: SitemapEntry[] = [];
  const removedUrls: SitemapEntry[] = [];
  const updatedUrls: SitemapEntry[] = [];

  for (const [url, entry] of currMap) {
    if (isNoise(url)) continue;
    const prevEntry = prevMap.get(url);
    if (!prevEntry) {
      newUrls.push(entry);
    } else if (
      entry.lastmod &&
      prevEntry.lastmod &&
      entry.lastmod !== prevEntry.lastmod
    ) {
      updatedUrls.push(entry);
    }
  }

  for (const [url, entry] of prevMap) {
    if (isNoise(url)) continue;
    if (!currMap.has(url)) {
      removedUrls.push(entry);
    }
  }

  return { competitorId, newUrls, removedUrls, updatedUrls };
}

async function main() {
  const competitorsPath = path.join(ROOT, 'data', 'competitors.json');
  const data: CompetitorsData = JSON.parse(fs.readFileSync(competitorsPath, 'utf-8'));
  const active = data.competitors.filter((c) => c.active);

  const snapshotDates = listSnapshotDates();
  const today = TODAY;
  const previous = snapshotDates.filter((d) => d < today).slice(-1)[0] || null;

  console.log(`Diffing sitemaps. Today: ${today}. Previous: ${previous || 'none'}\n`);

  const diffs: SitemapDiff[] = [];
  const fetchFailures: SitemapFetchFailure[] = [];

  for (const c of active) {
    const curr = loadSnapshot(today, c.id);
    if (curr.fetchError) {
      fetchFailures.push({
        competitorId: c.id,
        sourceUrl: curr.sourceUrl || c.sitemapUrl,
        error: curr.fetchError,
      });
      console.log(`✗ ${c.name}: sitemap fetch FAILED (${curr.fetchError})`);
      continue;
    }
    if (!curr.entries) {
      fetchFailures.push({
        competitorId: c.id,
        sourceUrl: c.sitemapUrl,
        error: 'No sitemap snapshot was written for this date.',
      });
      console.log(`✗ ${c.name}: no snapshot for today`);
      continue;
    }
    const prev = previous ? loadSnapshot(previous, c.id).entries : null;
    const d = diff(c.id, prev, curr.entries);
    diffs.push(d);
    console.log(
      `${c.name}: +${d.newUrls.length} new, -${d.removedUrls.length} removed, ~${d.updatedUrls.length} updated`
    );
  }

  const outDir = path.join(ROOT, 'data', 'diffs');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${today}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify({ date: today, previousDate: previous, diffs, fetchFailures }, null, 2)
  );
  console.log(`\nSaved diff to ${outPath}`);
  if (fetchFailures.length > 0) {
    console.log(`${fetchFailures.length} competitor sitemap(s) could not be fetched this run.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
