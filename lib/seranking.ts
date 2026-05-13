const BASE_URL = 'https://api.seranking.com';

export function isSeRankingConfigured(): boolean {
  return Boolean(process.env.SE_RANKING_API_KEY);
}

function authHeaders(): Record<string, string> {
  const key = process.env.SE_RANKING_API_KEY;
  if (!key) {
    throw new Error('SE_RANKING_API_KEY is not set');
  }
  return { Authorization: `Token ${key}`, Accept: 'application/json' };
}

async function get<T>(path: string, query: Record<string, string | number>): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
  const url = `${BASE_URL}${path}?${qs.toString()}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SE Ranking ${path} failed (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

// Strip protocol, www., and trailing slash. SE Ranking expects bare hostnames.
export function normalizeDomainForApi(domain: string): string {
  return domain
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '');
}

export interface DomainKeyword {
  keyword: string;
  position: number;
  prev_pos: number | null;
  volume: number;
  cpc: number;
  difficulty: number;
  traffic: number;
  url: string;
  intents?: string[];
}

export async function fetchTopKeywords(domain: string, limit = 50): Promise<DomainKeyword[]> {
  return get<DomainKeyword[]>('/v1/domain/keywords', {
    source: 'us',
    domain: normalizeDomainForApi(domain),
    type: 'organic',
    order_field: 'traffic',
    order_type: 'desc',
    limit,
  });
}

export interface BacklinksSummaryResponse {
  summary: BacklinksSummary[];
}

export interface BacklinksSummary {
  target: string;
  backlinks: number;
  refdomains: number;
  dofollow_backlinks: number;
  nofollow_backlinks: number;
  domain_inlink_rank: number;
  top_anchors_by_backlinks?: { anchor: string; backlinks: number }[];
  top_anchors_by_refdomains?: { anchor: string; refdomains: number }[];
  top_pages_by_backlinks?: { url: string; backlinks: number }[];
  top_pages_by_refdomains?: { url: string; refdomains: number }[];
  top_tlds?: { tld: string; count: number }[];
  top_countries?: { country: string; count: number }[];
}

export async function fetchBacklinksSummary(domain: string): Promise<BacklinksSummary | null> {
  const res = await get<BacklinksSummaryResponse>('/v1/backlinks/summary', {
    target: normalizeDomainForApi(domain),
    mode: 'domain',
    output: 'json',
  });
  return res.summary?.[0] || null;
}

export interface BacklinkHistoryEntry {
  new_lost_date: string;
  new_lost_type: 'new' | 'lost';
  url_from: string;
  url_to: string;
  title: string | null;
  anchor: string | null;
  nofollow: boolean;
  domain_inlink_rank: number;
  first_seen: string;
}

export interface BacklinkHistoryResponse {
  new_lost_backlinks: BacklinkHistoryEntry[];
}

export async function fetchNewBacklinks(
  domain: string,
  dateFrom: string,
  dateTo: string,
  limit = 100
): Promise<BacklinkHistoryEntry[]> {
  const res = await get<BacklinkHistoryResponse>('/v1/backlinks/history', {
    target: normalizeDomainForApi(domain),
    mode: 'domain',
    new_lost_type: 'new',
    date_from: dateFrom,
    date_to: dateTo,
    output: 'json',
    limit,
  });
  return res.new_lost_backlinks || [];
}

export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
}
