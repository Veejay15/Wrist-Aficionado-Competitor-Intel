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
interface FetchFailure {
  competitorId: string;
  sourceUrl: string;
  error: string;
}
interface DiffData {
  date: string;
  previousDate: string | null;
  diffs: CompetitorDiff[];
  fetchFailures?: FetchFailure[];
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

// Generates sections 1-3 (new pages, backlinks, keywords) for a single
// competitor. No executive summary. Recommendations are handled separately in
// generateCombinedRecommendations() after all competitors run.
async function generateForCompetitor(
  client: Anthropic,
  competitor: Competitor,
  diff: CompetitorDiff | null,
  csvs: CsvSummary[],
  seRanking: SeRankingSnapshot | null,
  previousDate: string | null,
  fetchFailure: FetchFailure | null
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
    // Explicit provenance so the model can tell "nothing happened" apart from
    // "we could not look". Never remove this.
    dataAvailability: {
      sitemapFetchFailed: !!fetchFailure,
      sitemapFetchError: fetchFailure?.error || null,
      sitemapSourceUrl: fetchFailure?.sourceUrl || null,
      seRankingAvailable: !!seRanking && !(seRanking.errors && seRanking.errors.length > 0),
      seRankingErrors: seRanking?.errors || null,
      csvUploaded: csvs.length > 0,
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
1. New Pages Built by ${competitor.name}
2. Backlink Movements
3. Keyword and Ranking Changes

Do NOT write an executive summary, an overview, or any preamble before Section 1. The client reads the data sections and the weekly recommendations, not a summary of them.

Do NOT include a Section 4 or any recommendations. Recommended actions are generated separately after all competitors are analyzed.

=========================================
DATA AVAILABILITY: READ THIS FIRST
=========================================
Absence of data is NOT evidence of absence of activity. If a data source failed or is missing, say the source failed. Never convert a data gap into a finding about the competitor.

Specifically, you must NEVER write or imply any of the following when data is missing or a fetch failed: that the competitor "published nothing", "was inactive", "showed no activity", "has a static content posture", "is holding steady", or any similar characterisation of their behaviour. You did not observe their behaviour. You failed to retrieve it. Those are different things and the client must be able to tell them apart.

If dataAvailability.sitemapFetchFailed is true, Section 1 must state that the sitemap could not be retrieved, quote the reason, and say that new page activity is UNKNOWN for this week. Do not speculate about what they did or did not publish.

=========================================
SECTION 1: NEW PAGES BUILT
=========================================
- If sitemapDiff.newUrls has entries: group URLs by brand (e.g. **Rolex**, **Patek Philippe**, **Audemars Piguet**) using bold brand headings. Under each heading, list URLs as bullet points with a one-sentence description of the inferred targeting intent based on the URL slug (e.g. "Targets pre-owned Royal Oak Offshore buyers with a specific dial variant."). If a URL does not belong to a known brand, group it under **Other**. Ignore individual single-SKU product listings — only group URLs that represent content pages, brand hubs, model guides, buying guides, or collection landing pages.
- If dataAvailability.sitemapFetchFailed is true: write "Sitemap retrieval FAILED for ${competitor.domain} this week, so new page activity is unknown. Reason: [quote dataAvailability.sitemapFetchError]. This is a monitoring gap on our side, not a finding about ${competitor.name}." Then stop. Do not describe their publishing behaviour in any way.
- If sitemapDiff.newUrls is empty but the sitemap WAS fetched successfully: write "${competitor.name} did not publish any notable new content pages this week."

=========================================
SECTION 2: BACKLINK MOVEMENTS
=========================================
- Always start with the overall backlink profile if seRanking.backlinksSummary is available: write one short paragraph covering total backlinks, referring domains, domain inlink rank, dofollow/nofollow split, and any notable anchor patterns. Label this paragraph **Overall profile (as of ${TODAY}):**
- DOMAIN AUTHORITY FILTER (SE Ranking data): Only include backlinks from seRanking.newBacklinks where domain_inlink_rank is 30 or higher. If qualifying entries exist, output a markdown table under the bold subheading **New high-authority backlinks (domain_inlink_rank 30 or higher):** with these exact columns in this order: | Source Domain | Domain Rank | Linking Page | Target Page | Anchor | Follow | Notes |. One row per backlink, up to 15 rows. In the Notes column add brief context (e.g. "Editorial contextual link", "App Store developer link; nofollow, low SEO impact", "Community forum thread; nofollow"). If domain_inlink_rank is missing, write "—". If no entries pass the threshold, write "No high-authority backlink movements this week (all new links were below rank 30)." and do not create a table.
- DOMAIN AUTHORITY FILTER (CSV data): If csvData has a backlinks-type entry, only include rows where Domain Authority (DA) is 30 or higher. If qualifying rows exist, output a table with columns: | Source Domain | DA | Source URL | Anchor Text | Follow | New/Lost |. If no rows pass, write "No high-authority backlink movements this week (all links were below DA 30)." and do not create a table.
- DIRECTORY OPPORTUNITY: If a competitor gained a high-authority link from a watch directory, review site, or luxury lifestyle publication, add a sentence below the table flagging it as a potential outreach opportunity for Wrist Aficionado.
- If no backlink data exists at all: state that the backlink source was unavailable and quote dataAvailability.seRankingErrors if present. Do not characterise the competitor's link building as slow, flat, or unchanged.

=========================================
SECTION 3: KEYWORD AND RANKING CHANGES
=========================================
- KEYWORD FILTER: Only include keywords that mention a specific luxury watch brand (e.g. Rolex, Patek Philippe, Audemars Piguet, AP, Richard Mille, Vacheron Constantin, A. Lange, IWC, Omega, Cartier, Breguet, F.P. Journe, Jaeger-LeCoultre, Panerai, Hublot, TAG Heuer, Breitling, Grand Seiko, Tudor, Zenith) OR a specific watch model or buying intent term (e.g. Daytona, Submariner, GMT-Master, Nautilus, Royal Oak, Skydweller, Aquanaut, for sale, buy, price, reference guide, pre-owned, certified, investment, value, authentication). Remove any keyword that is generic, informational, or brand-agnostic and does not reference a specific brand, model, or buying intent. If no keywords pass this filter, write "No brand- or model-specific keyword movements this week." and do not create a table.
- EMPTY TABLE RULE: If there are no qualifying gains, do NOT create an empty table. Write "No notable ranking gains this week." Same rule for declines.
- If SE Ranking topKeywords data is available, produce two separate tables under bold subheadings **Notable ranking gains** and **Notable ranking declines** using position vs prev_pos to determine movement. Each table MUST have columns: | Keyword | Previous Position | Current Position | Change | Search Volume | Landing Page |. Up to 12 rows per table.
- If csvData has a positions or keywords entry, merge it with SE Ranking data or use it as the source if SE Ranking is unavailable.
- If no keyword data exists at all: state that the keyword source was unavailable and quote dataAvailability.seRankingErrors if present. Do not characterise the competitor's rankings as stable or unchanged.

=========================================
STRICT ACCURACY RULES
=========================================
Focus areas relevant to luxury watch SEO: brand authority pages (Rolex, Patek Philippe, Audemars Piguet, Richard Mille, etc.), model reference guides, "for sale" intent pages, investment / value content, celebrity watch tie-ins, watch buying guides, and authentication / trust content.

Ignore individual product listings (single SKU pages or specific watch references with serial numbers). Focus on indexable content pages, brand hubs, model guides, blog posts, and category landing pages.

Do not invent data. Every number you write must appear in the DATA payload. Keep this report focused and specific to ${competitor.name} only, do not discuss other competitors.

Do not skip a section silently. If a section has no data, say which source was unavailable and why, per the DATA AVAILABILITY rules above.`;

  const isBaselineRun = diff !== null && previousDate === null;
  const baselineNote = isBaselineRun
    ? `(This is a baseline run with no previous sitemap snapshot, so every indexed URL appears as "new". Treat the sitemapDiff as a snapshot of ${competitor.name}'s current content footprint, not as activity from the last week. The "sitemapDiffTotals" object shows full counts; the URL arrays are sampled to the most relevant entries.)`
    : '';

  const userPrompt = `Here is this week's data for ${competitor.name} for the report dated ${TODAY}.

${fetchFailure ? `(WARNING: the sitemap fetch for ${competitor.domain} FAILED this week. Reason: ${fetchFailure.error} Treat new page activity as unknown. Do not describe what this competitor did or did not publish.)` : ''}
${!fetchFailure && !diff ? '(No sitemap diff available for this competitor this week.)' : ''}
${baselineNote}
${csvs.length === 0 ? '(No SEMrush CSV data uploaded for this competitor this week.)' : ''}
${hasSeRanking ? '(SE Ranking API data is included: seRanking.topKeywords shows top 50 organic keywords in the US database by estimated traffic; seRanking.backlinksSummary gives total link/domain counts and top anchors/pages; seRanking.newBacklinks lists up to 40 backlinks first seen in the last 7 days.)' : '(SE Ranking data could NOT be retrieved this week. See dataAvailability.seRankingErrors for the reason. This is a data gap, not a finding.)'}

DATA:
${JSON.stringify(dataPayload, null, 2)}

Write sections 1-3 only in markdown. Start with a top-level H1 like "# ${competitor.name}: Week of ${TODAY}", then go straight into "## 1. New Pages Built". No executive summary, no overview, no preamble. Do not include a Section 4 or any recommended actions.`;

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
// combined recommendations section (max 3 actions, each data backed and
// completable in a week) appended to every report.
async function generateCombinedRecommendations(
  client: Anthropic,
  competitorReports: { competitor: Competitor; markdown: string }[],
  wristAficionadoPages: string[]
): Promise<{ markdown: string; inputTokens: number; outputTokens: number }> {
  const competitorCount = competitorReports.length;

  const systemPrompt = `You are a luxury watch SEO specialist advising the marketing team at Wrist Aficionado, a luxury watch e-commerce and reseller platform competing against Bob's Watches, Avi & Co, Watches Off 5th, Luxury Time NYC, and Watch Guy NYC in the pre-owned and secondary market. You know this category: brand hierarchies, reference numbers, which models carry secondary market demand, and how buying intent differs from collector research intent.

You have just reviewed ${competitorCount} competitor(s) this week. Select the THREE highest-impact actions Wrist Aficionado should take, drawn from the combined activity across ALL competitors reviewed.

VOICE AND AUDIENCE RULES
Plain English, written for a marketing manager who is not an SEO. Tone: confident, direct, no fluff. No emojis. No em dashes.

EVERY RECOMMENDATION MUST BE BACKED BY DATA
The client explicitly asked for the numbers behind each recommendation. Each one must cite at least one concrete figure pulled from the competitor reports below: a search volume, a ranking position or position change, or a referring domain rank. Write the figure inline, in plain language, so the client can judge the size of the opportunity without opening a tool.

Only cite figures that actually appear in the competitor reports provided. Never estimate, never round up from nothing, never invent a search volume. If no figure exists anywhere in the reports to support an action, that action is not evidence based, so drop it and pick a different one. Fewer recommendations with real numbers beats three with invented ones.

OUTPUT FORMAT
- Start with this exact note on its own line in italics:
  "*Based on a review of all ${competitorCount} competitor(s) monitored this week.*"
- Then output exactly 3 numbered recommendations. Never more than 3. If only 2 are genuinely justified by the data, output 2. If only 1, output 1.
- Each recommendation must follow this format, with the bold labels exactly as written:
  "[Action in one sentence].
  **Trigger:** [which competitor did what this week].
  **Data:** [the specific figure or figures that size the opportunity, e.g. keyword, search volume, and who ranks where].
  **Why it matters for Wrist Aficionado:** [the gap this closes, naming the existing page or the absence of one]."
- For a NEW page recommendation: state the proposed URL slug and confirm the topic does not already exist on Wrist Aficionado's site.
- For an UPDATE recommendation: cite the existing Wrist Aficionado page path.

EACH RECOMMENDATION MUST BE DOABLE IN ONE WEEK
This report is weekly and the client's team executes it directly. Every recommendation must be completable by one person within a week, and must name the exact page and the exact change. Reject anything vague or open ended. "Strengthen the investment narrative", "improve internal linking", and "expand coverage" are not tasks, they are themes. "Add a 300 word 2026 market value section to /collections/rolex-daytona covering condition tiers and current pre-owned pricing" is a task. If the best idea you have is a theme rather than a task, break off the single most valuable week-sized piece of it and recommend only that.

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
    const fetchFailure = diffs?.fetchFailures?.find((f) => f.competitorId === competitor.id) || null;
    if (fetchFailure) {
      console.warn(`  ! Sitemap fetch failed for ${competitor.name}: ${fetchFailure.error}`);
    }

    try {
      const result = await generateForCompetitor(
        client,
        competitor,
        diff,
        csvs,
        seRanking,
        diffs?.previousDate || null,
        fetchFailure
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
      const combinedSection = `\n\n---\n\n## 4. Recommendations for the Week\n\n${combined.markdown}`;
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
