import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { Competitor, CompetitorsData } from '../lib/types';
import { fetchSitemap, isListingNoise } from '../lib/sitemap';
import type { SeRankingSnapshot } from './fetch-seranking';

const ROOT = process.cwd();
const TODAY = new Date().toISOString().split('T')[0];

const WRIST_AFICIONADO_SITEMAP_URL = 'https://wristaficionado.com/sitemap.xml';

interface DiffEntry {
  url: string;
  lastmod?: string;
}
interface CompetitorDiff {
  competitorId: string;
  newUrls: DiffEntry[];
  removedUrls: DiffEntry[];
  updatedUrls: DiffEntry[];
}
interface DiffData {
  date: string;
  previousDate: string | null;
  diffs: CompetitorDiff[];
}

interface CsvSummary {
  filename: string;
  competitorId: string;
  type: string;
  rowCount: number;
  topRows: Record<string, string>[];
}
interface CsvSummariesData {
  date: string;
  summaries: CsvSummary[];
}

function loadDiffs(): DiffData | null {
  const p = path.join(ROOT, 'data', 'diffs', `${TODAY}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function loadCsvSummaries(): CsvSummariesData | null {
  const p = path.join(ROOT, 'data', 'csv-summaries', `${TODAY}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function loadSeRanking(competitorId: string): SeRankingSnapshot | null {
  const p = path.join(ROOT, 'data', 'seranking', TODAY, `${competitorId}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

// Cap SE Ranking arrays to keep the prompt compact. Backlinks summary fields
// are already small; we mainly need to trim the new-backlinks list, which can
// reach hundreds of entries per competitor.
const MAX_SERANKING_KEYWORDS = 50;
const MAX_SERANKING_NEW_BACKLINKS = 40;

function trimSeRanking(snap: SeRankingSnapshot | null): SeRankingSnapshot | null {
  if (!snap) return null;
  return {
    ...snap,
    topKeywords: snap.topKeywords.slice(0, MAX_SERANKING_KEYWORDS),
    newBacklinks: snap.newBacklinks.slice(0, MAX_SERANKING_NEW_BACKLINKS).map((b) => ({
      ...b,
      title: b.title?.slice(0, 120) || null,
      anchor: b.anchor?.slice(0, 120) || null,
    })),
  };
}

function loadCompetitors(): Competitor[] {
  const p = path.join(ROOT, 'data', 'competitors.json');
  const data: CompetitorsData = JSON.parse(fs.readFileSync(p, 'utf-8'));
  return data.competitors.filter((c) => c.active);
}

async function fetchWristAficionadoPages(): Promise<string[]> {
  try {
    console.log(`Fetching Wrist Aficionado's own sitemap for cross-reference...`);
    const entries = await fetchSitemap(WRIST_AFICIONADO_SITEMAP_URL);
    const paths = entries
      .map((e) => e.url)
      .filter((url) => !isListingNoise(url))
      .map((url) => {
        try {
          return new URL(url).pathname;
        } catch {
          return url;
        }
      })
      .filter((p, i, arr) => arr.indexOf(p) === i)
      .sort();
    console.log(`  Found ${paths.length} content pages on wristaficionado.com`);
    return paths;
  } catch (err) {
    console.warn(`  Could not fetch Wrist Aficionado sitemap: ${(err as Error).message}`);
    return [];
  }
}

// Caps to keep the prompt under Claude's 1M-token limit. The first weekly run
// has no previous snapshot, so every URL becomes a "new" URL and competitors
// like Hodinkee or WatchBox produce 10k+ entries on their own.
const MAX_NEW_URLS = 150;
const MAX_UPDATED_URLS = 75;
const MAX_REMOVED_URLS = 75;
const MAX_CSV_ROWS = 15;
// SEMrush backlinks "Text" column can carry kilobytes of scraped HTML per row.
// Drop fields that bloat the payload without helping the analysis.
const CSV_FIELDS_TO_DROP = new Set(['Text', 'Frame', 'Form', 'Image', 'Sitewide']);

function trimDiff(diff: CompetitorDiff | null): { trimmed: CompetitorDiff; meta: Record<string, number> } {
  const empty = { newUrls: [], removedUrls: [], updatedUrls: [] };
  if (!diff) return { trimmed: { competitorId: '', ...empty }, meta: {} };
  return {
    trimmed: {
      competitorId: diff.competitorId,
      newUrls: diff.newUrls.slice(0, MAX_NEW_URLS),
      updatedUrls: diff.updatedUrls.slice(0, MAX_UPDATED_URLS),
      removedUrls: diff.removedUrls.slice(0, MAX_REMOVED_URLS),
    },
    meta: {
      totalNewUrls: diff.newUrls.length,
      totalUpdatedUrls: diff.updatedUrls.length,
      totalRemovedUrls: diff.removedUrls.length,
    },
  };
}

function trimCsvs(csvs: CsvSummary[]): CsvSummary[] {
  return csvs.map((c) => ({
    ...c,
    topRows: c.topRows.slice(0, MAX_CSV_ROWS).map((row) => {
      const trimmed: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        if (!CSV_FIELDS_TO_DROP.has(k)) trimmed[k] = v;
      }
      return trimmed;
    }),
  }));
}

// Generates sections 1-4 for a single competitor. Recommendations are handled
// separately in generateCombinedRecommendations() after all competitors run.
async function generateForCompetitor(
  client: Anthropic,
  competitor: Competitor,
  diff: CompetitorDiff | null,
  csvs: CsvSummary[],
  seRanking: SeRankingSnapshot | null,
  previousDate: string | null
): Promise<{ markdown: string; inputTokens: number; outputTokens: number }> {
  const { trimmed, meta } = trimDiff(diff);
  const dataPayload = {
    date: TODAY,
    previousDate,
    competitor: {
      id: competitor.id,
      name: competitor.name,
      domain: competitor.domain,
    },
    sitemapDiff: diff ? trimmed : { newUrls: [], removedUrls: [], updatedUrls: [] },
    sitemapDiffTotals: diff ? meta : null,
    csvData: trimCsvs(csvs),
    seRanking: trimSeRanking(seRanking),
  };

  const hasSeRanking = !!seRanking && (seRanking.topKeywords.length > 0 || seRanking.newBacklinks.length > 0 || !!seRanking.backlinksSummary);

  const systemPrompt = `You are a senior SEO analyst preparing a focused weekly competitor intelligence report for Wrist Aficionado, a luxury watch e-commerce and reseller platform.

This report covers ONE competitor: ${competitor.name} (${competitor.domain}).

Tone: confident, direct, no fluff. No emojis. No em dashes (use periods, commas, parentheses, or "and/but" instead).

Structure:
1. Executive Summary (2 to 4 bullet points, what this competitor did this week)
2. New Pages Built by ${competitor.name} (list URLs and infer what they're targeting based on URL slugs, e.g. brand pages, model reference guides, buying guides, collection landing pages)
3. Backlink Movements (use the seRanking.backlinksSummary for overall scale, seRanking.newBacklinks for recently acquired links, and any CSV data provided.)
4. Keyword and Ranking Changes (use seRanking.topKeywords for the competitor's current organic footprint in the US, called out by traffic, position, and search intent. Compare position vs prev_pos to flag movement. Combine with any CSV data provided.)

Do NOT include a Section 5 or any recommendations. Recommended actions are generated separately after all competitors are analyzed.

=========================================
SECTION 3: BACKLINK MOVEMENTS
=========================================
- DOMAIN AUTHORITY FILTER (SE Ranking data): Only include backlinks from seRanking.newBacklinks where domain_inlink_rank is 30 or higher. Skip every entry where domain_inlink_rank is below 30, zero, or missing. If no entries pass this threshold, write "No high-authority backlink movements this week (all new links were below rank 30)." and do not create a table.
- DOMAIN AUTHORITY FILTER (CSV data): If csvData has a backlinks-type entry, only include rows where Domain Authority (DA) is 30 or higher. Skip rows below DA 30, zero, or missing. If no rows pass, write "No high-authority backlink movements this week (all links were below DA 30)." and do not create a table.
- DIRECTORY OPPORTUNITY: If a competitor gained a high-authority link from a watch directory, review site, or luxury lifestyle publication, add a sentence flagging it as a potential outreach opportunity for Wrist Aficionado.
- If no backlink data exists at all: "No backlink data available for this competitor this week."

=========================================
SECTION 4: KEYWORD AND RANKING CHANGES
=========================================
- KEYWORD FILTER: Only include keywords that mention a specific luxury watch brand (e.g. Rolex, Patek Philippe, Audemars Piguet, AP, Richard Mille, Vacheron Constantin, A. Lange, IWC, Omega, Cartier, Breguet, F.P. Journe, Jaeger-LeCoultre, Panerai, Hublot, TAG Heuer, Breitling, Grand Seiko, Tudor, Zenith) OR a specific watch model or buying intent term (e.g. Daytona, Submariner, GMT-Master, Nautilus, Royal Oak, Skydweller, Aquanaut, for sale, buy, price, reference guide, pre-owned, certified, investment, value, authentication). Remove any keyword that is generic, informational, or brand-agnostic and does not reference a specific brand, model, or buying intent. If no keywords pass this filter, write "No brand- or model-specific keyword movements this week." and do not create a table.
- EMPTY TABLE RULE: If there are no qualifying gains, do NOT create an empty table. Write "No notable ranking gains this week." Same rule for declines.
- If SE Ranking topKeywords data is available, produce two separate tables under bold subheadings **Notable ranking gains** and **Notable ranking declines** using position vs prev_pos to determine movement. Each table MUST have columns: | Keyword | Previous Position | Current Position | Change | Search Volume | Landing Page |. Up to 12 rows per table.
- If csvData has a positions or keywords entry, merge it with SE Ranking data or use it as the source if SE Ranking is unavailable.
- If no keyword data exists at all: "No keyword and ranking data available for this competitor this week."

=========================================
STRICT ACCURACY RULES
=========================================
Focus areas relevant to luxury watch SEO: brand authority pages (Rolex, Patek Philippe, Audemars Piguet, Richard Mille, etc.), model reference guides, "for sale" intent pages, investment / value content, celebrity watch tie-ins, watch buying guides, and authentication / trust content.

Ignore individual product listings (single SKU pages or specific watch references with serial numbers). Focus on indexable content pages, brand hubs, model guides, blog posts, and category landing pages.

Skip sections where there is no data. Do not invent data. Keep this report focused and specific to ${competitor.name} only, do not discuss other competitors.`;

  const isBaselineRun = diff !== null && previousDate === null;
  const baselineNote = isBaselineRun
    ? `(This is a baseline run with no previous sitemap snapshot, so every indexed URL appears as "new". Treat the sitemapDiff as a snapshot of ${competitor.name}'s current content footprint, not as activity from the last week. The "sitemapDiffTotals" object shows full counts; the URL arrays are sampled to the most relevant entries.)`
    : '';

  const userPrompt = `Here is this week's data for ${competitor.name} for the report dated ${TODAY}.

${diff ? '' : '(No sitemap diff available for this competitor this week.)'}
${baselineNote}
${csvs.length === 0 ? '(No SEMrush CSV data uploaded for this competitor this week.)' : ''}
${hasSeRanking ? '(SE Ranking API data is included: seRanking.topKeywords shows top 50 organic keywords in the US database by estimated traffic; seRanking.backlinksSummary gives total link/domain counts and top anchors/pages; seRanking.newBacklinks lists up to 40 backlinks first seen in the last 7 days.)' : '(No SE Ranking data available for this competitor this week.)'}

DATA:
${JSON.stringify(dataPayload, null, 2)}

Write sections 1-4 only in markdown. Start with a top-level H1 like "# ${competitor.name}: Week of ${TODAY}". Do not include a Section 5 or any recommended actions.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 6000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text in Claude response');
  }
  return {
    markdown: textBlock.text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// After all per-competitor reports are generated, this produces a single
// combined recommendations section (top 3-4 actions) appended to every report.
async function generateCombinedRecommendations(
  client: Anthropic,
  competitorReports: { competitor: Competitor; markdown: string }[],
  wristAficionadoPages: string[]
): Promise<{ markdown: string; inputTokens: number; outputTokens: number }> {
  const competitorCount = competitorReports.length;

  const systemPrompt = `You are a senior SEO analyst advising the marketing team at Wrist Aficionado, a luxury watch e-commerce and reseller platform. You have just reviewed ${competitorCount} competitor(s) this week. Your job is to select the top 3 to 4 highest-impact content actions Wrist Aficionado should take, drawn from the combined activity across ALL competitors reviewed.

VOICE AND AUDIENCE RULES
Plain English. No jargon. No data references. Tone: confident, direct, no fluff. No emojis. No em dashes.

OUTPUT FORMAT
- Start with this exact note on its own line in italics:
  "*These are combined recommended actions based on a review of all ${competitorCount} competitor(s) monitored this week.*"
- Then output exactly 3 to 4 numbered recommendations.
- Each recommendation must follow this format:
  "[Action]. Trigger: [which competitor did what]. Why this fits Wrist Aficionado: [the brand, model, or buying intent segment this builds on]."
- For a NEW page recommendation: state the proposed URL slug and confirm the topic does not already exist on Wrist Aficionado's site.
- For an UPDATE recommendation: cite the existing Wrist Aficionado page path.

SELECTION CRITERIA - rank and keep only the actions that are:
1. Highest signal (multiple competitors pointing to the same gap, or one unusually significant move)
2. Most immediately actionable (Wrist Aficionado can build or update this now)
3. Most aligned with Wrist Aficionado's actual luxury watch focus areas:
   - Brand authority pages: Rolex, Patek Philippe, Audemars Piguet, Richard Mille, Vacheron Constantin, A. Lange, IWC, Omega, Cartier, Breguet, F.P. Journe, Jaeger-LeCoultre, Panerai, Hublot, TAG Heuer, Breitling, Grand Seiko, Tudor, Zenith
   - Model reference guides and buying guides (e.g. Daytona, Submariner, GMT-Master, Nautilus, Royal Oak, Skydweller, Aquanaut)
   - "For sale" intent pages, pre-owned / certified pre-owned, investment and value content
   - Celebrity watch tie-ins and authentication / trust content
   - Collection landing pages and watch buying guides

MARKET RELEVANCE: Only draw recommendations from competitor activity that overlaps with Wrist Aficionado's actual luxury watch niche. If a competitor made a move targeting a market segment Wrist Aficionado does not serve (e.g. entry-level watches, non-luxury brands), skip it. Every recommendation must link to something a competitor did this week in a brand or segment where Wrist Aficionado operates.

DO NOT recommend pages Wrist Aficionado already has. Wrist Aficionado's existing pages are provided below.
DO NOT pad with generic SEO advice. Every recommendation must link to something a competitor did this week.
Ignore individual product listings (single SKU pages). Focus on indexable content pages, brand hubs, model guides, blog posts, and category landing pages.
A focused list of 3 actions beats a padded list of 6. If only 2 actions are genuinely justified, output 2.

Do not include an H1, H2, or section title in your output. Start directly with the italics note.`;

  const competitorSummaries = competitorReports
    .map((r, i) => `--- COMPETITOR ${i + 1}: ${r.competitor.name} (${r.competitor.domain}) ---\n${r.markdown}`)
    .join('\n\n');

  const userPrompt = `Date: ${TODAY}

Wrist Aficionado's existing ${wristAficionadoPages.length} content pages (cross-reference — do not recommend pages already covered):
${JSON.stringify(wristAficionadoPages)}

COMPETITOR ANALYSES THIS WEEK:
${competitorSummaries}

Output the combined recommended actions now.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text in Claude response for combined recommendations');
  }
  return {
    markdown: textBlock.text,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set');
    process.exit(1);
  }

  const competitors = loadCompetitors();
  if (competitors.length === 0) {
    console.log('No active competitors. Skipping report generation.');
    process.exit(0);
  }

  const diffs = loadDiffs();
  const csvSummaries = loadCsvSummaries();
  const wristAficionadoPages = await fetchWristAficionadoPages();

  const hasAnySeRanking = competitors.some((c) => loadSeRanking(c.id));

  if (!diffs && !csvSummaries && !hasAnySeRanking) {
    console.log('No data to report on. Run fetch-sitemaps, process-csvs, or fetch-seranking first.');
    process.exit(0);
  }

  const client = new Anthropic({ apiKey });
  const reportsDir = path.join(ROOT, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  let totalInput = 0;
  let totalOutput = 0;
  const succeeded: string[] = [];
  const failed: string[] = [];
  const succeededReports: { filePath: string; competitor: Competitor; markdown: string }[] = [];

  for (const competitor of competitors) {
    console.log(`\nGenerating report for ${competitor.name}...`);
    const diff = diffs?.diffs.find((d) => d.competitorId === competitor.id) || null;
    const csvs = csvSummaries?.summaries.filter((s) => s.competitorId === competitor.id) || [];
    const seRanking = loadSeRanking(competitor.id);

    try {
      const result = await generateForCompetitor(
        client,
        competitor,
        diff,
        csvs,
        seRanking,
        diffs?.previousDate || null
      );
      const filename = `${TODAY}-${competitor.id}.md`;
      const outPath = path.join(reportsDir, filename);
      fs.writeFileSync(outPath, result.markdown);
      console.log(`  ✓ Saved ${outPath}`);
      console.log(`    Tokens: input ${result.inputTokens}, output ${result.outputTokens}`);
      totalInput += result.inputTokens;
      totalOutput += result.outputTokens;
      succeeded.push(competitor.name);
      succeededReports.push({ filePath: outPath, competitor, markdown: result.markdown });
    } catch (err) {
      console.error(`  ✗ Failed: ${(err as Error).message}`);
      failed.push(competitor.name);
    }
  }

  // Generate one combined recommendations section across all competitors and
  // append it to every report so the client sees a single prioritised list.
  if (succeededReports.length > 0) {
    console.log(`\nGenerating combined recommended actions (${succeededReports.length} competitor(s))...`);
    try {
      const combined = await generateCombinedRecommendations(
        client,
        succeededReports.map((r) => ({ competitor: r.competitor, markdown: r.markdown })),
        wristAficionadoPages
      );
      const combinedSection = `\n\n---\n\n## 5. Recommended Actions for Wrist Aficionado\n\n${combined.markdown}`;
      for (const report of succeededReports) {
        fs.appendFileSync(report.filePath, combinedSection);
      }
      totalInput += combined.inputTokens;
      totalOutput += combined.outputTokens;
      console.log(`  ✓ Combined recommendations appended to ${succeededReports.length} report(s)`);
      console.log(`    Tokens: input ${combined.inputTokens}, output ${combined.outputTokens}`);
    } catch (err) {
      console.error(`  ✗ Combined recommendations failed: ${(err as Error).message}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Succeeded: ${succeeded.length} (${succeeded.join(', ') || 'none'})`);
  console.log(`Failed: ${failed.length} (${failed.join(', ') || 'none'})`);
  console.log(`Total tokens: input ${totalInput}, output ${totalOutput}`);

  if (succeeded.length === 0) {
    console.error('All competitor reports failed.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
