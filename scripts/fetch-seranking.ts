import fs from 'fs';
import path from 'path';
import { CompetitorsData } from '../lib/types';
import {
  fetchTopKeywords,
  fetchBacklinksSummary,
  fetchNewBacklinks,
  isSeRankingConfigured,
  isoDaysAgo,
  BacklinksSummary,
  DomainKeyword,
  BacklinkHistoryEntry,
} from '../lib/seranking';

const ROOT = process.cwd();
const TODAY = new Date().toISOString().split('T')[0];

export interface SeRankingSnapshot {
  fetchedAt: string;
  competitorId: string;
  domain: string;
  topKeywords: DomainKeyword[];
  backlinksSummary: BacklinksSummary | null;
  newBacklinks: BacklinkHistoryEntry[];
  dateRange: { from: string; to: string };
  errors: string[];
}

async function fetchForCompetitor(
  competitorId: string,
  domain: string,
  dateFrom: string,
  dateTo: string
): Promise<SeRankingSnapshot> {
  const snap: SeRankingSnapshot = {
    fetchedAt: new Date().toISOString(),
    competitorId,
    domain,
    topKeywords: [],
    backlinksSummary: null,
    newBacklinks: [],
    dateRange: { from: dateFrom, to: dateTo },
    errors: [],
  };

  try {
    console.log(`  Fetching top keywords...`);
    snap.topKeywords = await fetchTopKeywords(domain, 50);
    console.log(`    ${snap.topKeywords.length} keywords`);
  } catch (err) {
    const msg = `keywords: ${(err as Error).message}`;
    console.error(`    ✗ ${msg}`);
    snap.errors.push(msg);
  }

  try {
    console.log(`  Fetching backlinks summary...`);
    snap.backlinksSummary = await fetchBacklinksSummary(domain);
    if (snap.backlinksSummary) {
      console.log(`    ${snap.backlinksSummary.backlinks.toLocaleString()} total backlinks, ${snap.backlinksSummary.refdomains.toLocaleString()} ref domains`);
    }
  } catch (err) {
    const msg = `backlinks summary: ${(err as Error).message}`;
    console.error(`    ✗ ${msg}`);
    snap.errors.push(msg);
  }

  try {
    console.log(`  Fetching new backlinks since ${dateFrom}...`);
    snap.newBacklinks = await fetchNewBacklinks(domain, dateFrom, dateTo, 100);
    console.log(`    ${snap.newBacklinks.length} new backlinks`);
  } catch (err) {
    const msg = `new backlinks: ${(err as Error).message}`;
    console.error(`    ✗ ${msg}`);
    snap.errors.push(msg);
  }

  return snap;
}

async function main() {
  if (!isSeRankingConfigured()) {
    console.log('SE_RANKING_API_KEY not set, skipping SE Ranking fetch.');
    process.exit(0);
  }

  const competitorsPath = path.join(ROOT, 'data', 'competitors.json');
  const data: CompetitorsData = JSON.parse(fs.readFileSync(competitorsPath, 'utf-8'));
  const active = data.competitors.filter((c) => c.active);

  if (active.length === 0) {
    console.log('No active competitors. Skipping.');
    process.exit(0);
  }

  const outDir = path.join(ROOT, 'data', 'seranking', TODAY);
  fs.mkdirSync(outDir, { recursive: true });

  const dateTo = TODAY;
  const dateFrom = isoDaysAgo(7);

  console.log(`Fetching SE Ranking data for ${active.length} competitors (${dateFrom} to ${dateTo})\n`);

  for (const c of active) {
    console.log(`${c.name} (${c.domain})`);
    const snap = await fetchForCompetitor(c.id, c.domain, dateFrom, dateTo);
    const outPath = path.join(outDir, `${c.id}.json`);
    fs.writeFileSync(outPath, JSON.stringify(snap, null, 2));
    console.log(`  Saved ${outPath}\n`);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
