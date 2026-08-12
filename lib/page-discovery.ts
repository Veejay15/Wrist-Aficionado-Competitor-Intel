import { SitemapEntry } from './types';

// Some competitors sit behind bot protection that blocks sitemap retrieval
// outright (Avi & Co runs a Cloudflare managed challenge across their whole
// domain, including robots.txt). For those we fall back to the pages SE Ranking
// has already observed: keyword landing pages, backlink target pages, and the
// most linked pages on the domain.
//
// This is a NARROWER signal than a sitemap and must be labelled as such in the
// report. A sitemap lists everything the competitor publishes. This lists only
// what has started ranking or attracting links, so a genuinely new page shows up
// here weeks after it went live, and never shows up at all if it stays invisible.
// It answers "what of theirs is gaining traction" and not "what did they build".

interface SeRankingLike {
  topKeywords?: { url?: string | null }[];
  newBacklinks?: { url_to?: string | null }[];
  backlinksSummary?: {
    top_pages_by_backlinks?: { url?: string | null }[];
    top_pages_by_refdomains?: { url?: string | null }[];
  } | null;
}

// Assets and paginated/filtered variants are not "pages the competitor built".
const NON_PAGE_PATTERNS = [
  /\.(jpe?g|png|gif|webp|svg|css|js|ico|pdf|xml|woff2?)(\?|$)/i,
  /\/media\//i,
  /\/static\//i,
];

function normalise(raw: string | null | undefined, domain: string): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // The host exactly as configured for this competitor, www included if that is
  // how the site actually serves. Used as the canonical display form so the URLs
  // in the report match the competitor's real URLs.
  const canonicalHost = domain
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();

  // Compare with www stripped from both sides, so www and non-www match.
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  const target = canonicalHost.replace(/^www\./i, '');
  if (host !== target) return null;

  if (NON_PAGE_PATTERNS.some((re) => re.test(parsed.pathname + parsed.search))) return null;

  // Canonicalise so the same page cannot appear more than once. SE Ranking
  // returns http/https and www/non-www variants of the same URL, which would
  // otherwise show up as separate "newly visible" pages.
  parsed.protocol = 'https:';
  parsed.hostname = canonicalHost;
  // Drop query strings and fragments so filter/sort variants collapse to one page.
  // aviandco.com surfaces "?price=amshopby_slider_from-amshopby_slider_to" copies
  // of every collection page, which would otherwise double the inventory.
  parsed.search = '';
  parsed.hash = '';
  let out = parsed.toString();
  if (out.endsWith('/') && parsed.pathname !== '/') out = out.slice(0, -1);
  return out;
}

export function derivePagesFromSeRanking(
  snapshot: SeRankingLike | null,
  domain: string
): SitemapEntry[] {
  if (!snapshot) return [];
  const urls = new Set<string>();

  for (const k of snapshot.topKeywords || []) {
    const u = normalise(k.url, domain);
    if (u) urls.add(u);
  }
  for (const b of snapshot.newBacklinks || []) {
    const u = normalise(b.url_to, domain);
    if (u) urls.add(u);
  }
  for (const p of snapshot.backlinksSummary?.top_pages_by_backlinks || []) {
    const u = normalise(p.url, domain);
    if (u) urls.add(u);
  }
  for (const p of snapshot.backlinksSummary?.top_pages_by_refdomains || []) {
    const u = normalise(p.url, domain);
    if (u) urls.add(u);
  }

  return [...urls].sort().map((url) => ({ url }));
}
