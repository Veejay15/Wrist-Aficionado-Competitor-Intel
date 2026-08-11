import fs from 'fs';
import path from 'path';
import { Competitor, CompetitorsData } from '../lib/types';
import { fetchSitemap } from '../lib/sitemap';

const ROOT = process.cwd();
const TODAY = new Date().toISOString().split('T')[0];
const OUT_DIR = path.join(ROOT, 'data', 'sitemaps', TODAY);

async function fetchCompetitor(c: Competitor): Promise<void> {
  console.log(`Fetching ${c.name} (${c.sitemapUrl})`);
  try {
    const entries = await fetchSitemap(c.sitemapUrl);
    const outPath = path.join(OUT_DIR, `${c.id}.json`);
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          competitorId: c.id,
          fetchedAt: new Date().toISOString(),
          sourceUrl: c.sitemapUrl,
          entryCount: entries.length,
          entries,
        },
        null,
        2
      )
    );
    console.log(`  ✓ ${entries.length} URLs saved to ${outPath}`);
  } catch (err) {
    // Write a failure record rather than nothing. Previously a failed fetch left
    // no file, the competitor silently dropped out of the diff, and the report
    // rendered that absence as "no new pages this week". Avi & Co sat behind a
    // Cloudflare managed challenge for three months and was reported as dormant.
    const message = (err as Error).message;
    const outPath = path.join(OUT_DIR, `${c.id}.json`);
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          competitorId: c.id,
          fetchedAt: new Date().toISOString(),
          sourceUrl: c.sitemapUrl,
          entryCount: 0,
          entries: [],
          fetchError: message,
        },
        null,
        2
      )
    );
    console.error(`  ✗ Failed: ${message} (recorded to ${outPath})`);
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const competitorsPath = path.join(ROOT, 'data', 'competitors.json');
  const data: CompetitorsData = JSON.parse(fs.readFileSync(competitorsPath, 'utf-8'));
  const active = data.competitors.filter((c) => c.active);

  console.log(`Fetching ${active.length} active competitor sitemaps for ${TODAY}\n`);

  for (const c of active) {
    await fetchCompetitor(c);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
