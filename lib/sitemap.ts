import { XMLParser } from 'fast-xml-parser';
import { SitemapEntry } from './types';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

const USER_AGENT = 'WristAficionado-CompetitorIntel/1.0 (+https://wristaficionado.com)';

// Optional pass-through for sites behind bot protection that a plain fetch
// cannot clear. Set SCRAPE_PROXY_URL to a provider endpoint containing {url},
// e.g. https://api.example.com/v1/?api_key=KEY&render_js=true&url={url}
// Left unset, everything fetches directly and nothing changes. Note that a
// User-Agent swap alone does NOT get past a Cloudflare managed challenge; that
// was tested against aviandco.com on 2026-08-11 and blocked in every variant,
// including real headed Chrome.
const SCRAPE_PROXY_URL = process.env.SCRAPE_PROXY_URL;

function resolveFetchUrl(url: string): string {
  if (!SCRAPE_PROXY_URL) return url;
  return SCRAPE_PROXY_URL.replace('{url}', encodeURIComponent(url));
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(resolveFetchUrl(url), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status}`);
  }
  return res.text();
}

export async function parseSitemapXml(xml: string): Promise<SitemapEntry[]> {
  const parsed = parser.parse(xml);
  const entries: SitemapEntry[] = [];

  if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
    const children = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];

    for (const child of children) {
      const childUrl = child.loc;
      if (!childUrl) continue;
      try {
        const childXml = await fetchText(childUrl);
        const childEntries = await parseSitemapXml(childXml);
        entries.push(...childEntries);
      } catch {
        // Skip child sitemap on failure
      }
    }
    return entries;
  }

  if (parsed.urlset && parsed.urlset.url) {
    const urls = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
    for (const u of urls) {
      if (u.loc) {
        entries.push({
          url: typeof u.loc === 'string' ? u.loc : String(u.loc),
          lastmod: u.lastmod ? String(u.lastmod) : undefined,
        });
      }
    }
  }

  return entries;
}

export async function fetchSitemap(sitemapUrl: string): Promise<SitemapEntry[]> {
  const xml = await fetchText(sitemapUrl);
  return parseSitemapXml(xml);
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

export function isListingNoise(url: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(url));
}
