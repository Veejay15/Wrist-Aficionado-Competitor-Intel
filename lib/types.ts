export interface Competitor {
  id: string;
  name: string;
  domain: string;
  sitemapUrl: string;
  addedAt: string;
  active: boolean;
}

export interface CompetitorsData {
  competitors: Competitor[];
}

export interface SitemapEntry {
  url: string;
  lastmod?: string;
}

export interface SitemapSnapshot {
  competitorId: string;
  fetchedAt: string;
  entries: SitemapEntry[];
  // Present only when the fetch failed. A snapshot carrying this must never be
  // treated as "zero pages", otherwise a blocked competitor reads as one that
  // deleted its entire site.
  fetchError?: string;
}

export interface SitemapDiff {
  competitorId: string;
  newUrls: SitemapEntry[];
  removedUrls: SitemapEntry[];
  updatedUrls: SitemapEntry[];
}

// Competitors whose sitemap could not be retrieved this week. Carried through
// to the report so "we could not look" is never written up as "they did nothing".
export interface SitemapFetchFailure {
  competitorId: string;
  sourceUrl: string;
  error: string;
}

export interface Report {
  date: string;
  filename: string;
  slug: string;
  competitorId: string | null;
  competitorName: string | null;
  title?: string;
  excerpt?: string;
}

export interface AppSettings {
  scheduledReports: boolean;
  scheduleDescription: string;
}

export interface CsvManifestEntry {
  filename: string;
  blobUrl: string;
  uploadedAt: string;
  size: number;
  competitorId?: string; // explicitly set by user at upload time
  type?: string; // backlinks / positions / keywords / pages / unknown
}

export interface CsvManifest {
  date: string;
  files: CsvManifestEntry[];
}
