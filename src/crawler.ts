import axios from 'axios';
import * as cheerio from 'cheerio';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse');

export interface SourceDocument {
  /** Human-readable citation shown to the user. */
  source: string;
  source_type: 'mcc' | 'icc';
  /** null means "applies to all formats". */
  format: 'test' | 'odi' | 't20i' | null;
  law_number: string | null;
  law_title: string | null;
  /** Canonical link the answer can cite. */
  url: string;
  content: string;
}

const BASE = 'https://www.lords.org';
const LAWS_BASE = '/mcc/the-laws-of-cricket-2d35b4b95a4a67ae8f9c76f258a84aa8';
const MCC_SOURCE = 'MCC Laws of Cricket (2017 Code, 3rd Edition 2022)';

/**
 * Ordered exactly as the MCC publishes them: the preamble, then Laws 1-42,
 * then the appendices. The array index is what gives each page its law number,
 * which the site's own markup does not expose reliably.
 */
const LAW_PATHS = [
  '/preamble-to-the-laws-spirit-of-cricket',
  '/the-players',
  '/the-umpires',
  '/the-scorers',
  '/the-ball',
  '/the-bat',
  '/the-pitch',
  '/the-creases',
  '/the-wickets',
  '/preparation-and-maintenance-of-the-playing-area',
  '/covering-the-pitch',
  '/intervals',
  '/start-of-play;-cessation-of-play',
  '/innings',
  '/the-follow-on',
  '/declaration-and-forfeiture',
  '/the-result',
  '/the-over',
  '/scoring-runs',
  '/boundaries',
  '/dead-ball',
  '/no-ball',
  '/wide-ball',
  '/bye-and-leg-bye',
  '/fielders-absence;-substitutes',
  '/batsman-s-innings;-runners',
  '/practice-on-the-field',
  '/the-wicket-keeper',
  '/the-fielder',
  '/the-wicket-is-down',
  '/batsman-out-of-his-her-ground',
  '/appeals',
  '/bowled',
  '/caught',
  '/hit-the-ball-twice',
  '/hit-wicket',
  '/leg-before-wicket',
  '/obstructing-the-field',
  '/run-out',
  '/stumped',
  '/timed-out',
  '/unfair-play',
  '/players-conduct',
  '/law-appendices',
];

const ICC_PDFS: { name: string; url: string; format: 'test' | 'odi' | 't20i' }[] = [
  {
    name: 'ICC Test Match Playing Conditions',
    url: 'https://images.icc-cricket.com/image/upload/prd/lm8owaz03i86m1eneb7m.pdf',
    format: 'test',
  },
  {
    name: 'ICC ODI Playing Conditions',
    url: 'https://images.icc-cricket.com/image/upload/prd/d25dbgishkx0kijb4jeu.pdf',
    format: 'odi',
  },
  {
    name: 'ICC T20I Playing Conditions',
    url: 'https://images.icc-cricket.com/image/upload/prd/qfnsie8fz6vhyl1pmcli.pdf',
    format: 't20i',
  },
];

const USER_AGENT = 'Mozilla/5.0 (compatible; CricOracle/1.0; educational project)';

/** Index 0 is the preamble and the last entry is the appendices; 1..42 are Laws 1..42. */
function lawNumberForIndex(index: number): string | null {
  if (index === 0) return null;
  if (index >= LAW_PATHS.length - 1) return null;
  return String(index);
}

async function fetchPage(url: string): Promise<string> {
  const response = await axios.get(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 15000,
  });
  return response.data;
}

async function downloadPDF(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': USER_AGENT },
    timeout: 60000,
  });
  return Buffer.from(response.data);
}

function extractLawText($: cheerio.CheerioAPI): { title: string; content: string } {
  $(
    'nav, header, footer, script, style, .navigation, .breadcrumb, .cookie, [class*="cookie"], [class*="nav"], [class*="header"], [class*="footer"], iframe, noscript'
  ).remove();

  const title = $('h1').first().text().trim();

  const selectors = ['main', 'article', '.law-content', '.page-content', '.content', '#content', '.container', 'body'];
  let content = '';

  for (const sel of selectors) {
    const text = $(sel).text().trim();
    if (text.length > 200) {
      content = text;
      break;
    }
  }

  content = content
    .replace(/\t/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();

  return { title, content };
}

function titleFromPath(path: string): string {
  return path
    .replace(/^\//, '')
    .replace(/-/g, ' ')
    .replace(/;/g, ';')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Minimum MCC law pages a crawl must yield before it may replace the corpus. */
const MIN_MCC_PAGES = 30;

export class IncompleteCrawlError extends Error {
  constructor(
    message: string,
    readonly counts: { mcc: number; icc: number }
  ) {
    super(message);
    this.name = 'IncompleteCrawlError';
  }
}

/**
 * Guards the destructive swap.
 *
 * Indexing clears the corpus before inserting, so a partial crawl is worse
 * than no crawl: when lords.org was unreachable, the pipeline still returned
 * 3 ICC PDFs, which is a truthy, non-empty result that would have passed a
 * naive `length === 0` check and silently deleted all 42 MCC Laws. A crawl
 * must be complete enough to stand in for the whole corpus, or it must abort
 * while the existing rows are still intact.
 */
export function assertCorpusComplete(documents: SourceDocument[]): void {
  const mcc = documents.filter((d) => d.source_type === 'mcc').length;
  const icc = documents.filter((d) => d.source_type === 'icc').length;

  if (mcc < MIN_MCC_PAGES || icc === 0) {
    throw new IncompleteCrawlError(
      `Refusing to replace the corpus: crawl returned ${mcc} MCC law pages ` +
        `(need at least ${MIN_MCC_PAGES}) and ${icc} ICC documents (need at least 1). ` +
        `The existing corpus has been left untouched. ` +
        `Check source reachability before retrying, or pass --allow-partial to override.`,
      { mcc, icc }
    );
  }
}

/**
 * @param only  restrict the crawl to one source family. Pushing the scope down
 *              here rather than filtering afterwards matters when a source is
 *              unreachable: crawling 44 lords.org pages that will be discarded
 *              costs 44 x the request timeout before the ICC PDFs are even
 *              attempted.
 */
export async function crawlLaws(only: 'mcc' | 'icc' | null = null): Promise<SourceDocument[]> {
  const documents: SourceDocument[] = [];

  if (only === 'icc') {
    console.log('\nSkipping MCC law pages (--only=icc)');
  } else {
  console.log(`\nScraping ${LAW_PATHS.length} MCC law pages from lords.org...`);
  let scraped = 0;

  for (let i = 0; i < LAW_PATHS.length; i++) {
    const path = LAW_PATHS[i];
    const url = BASE + LAWS_BASE + path;
    const lawNumber = lawNumberForIndex(i);

    try {
      const html = await fetchPage(url);
      const $ = cheerio.load(html);
      const { title, content } = extractLawText($);

      if (content.length <= 100) {
        console.error(`  Thin content, skipped: ${path}`);
        continue;
      }

      documents.push({
        source: MCC_SOURCE,
        source_type: 'mcc',
        format: null,
        law_number: lawNumber,
        law_title: title || titleFromPath(path),
        url,
        content,
      });
      scraped++;

      await new Promise((r) => setTimeout(r, 400));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Failed: ${path.split('/').pop()} - ${msg}`);
    }
  }

  console.log(`  Scraped ${scraped}/${LAW_PATHS.length} law pages`);
  }

  if (only === 'mcc') {
    console.log('\nSkipping ICC PDFs (--only=mcc)');
    console.log(`\nTotal documents loaded: ${documents.length}`);
    return documents;
  }

  for (const source of ICC_PDFS) {
    try {
      console.log(`\nDownloading: ${source.name}`);
      const buffer = await downloadPDF(source.url);
      console.log(`  Downloaded ${Math.round(buffer.byteLength / 1024)} KB, parsing...`);

      const data = await pdfParse(buffer);
      console.log(`  Extracted ${data.text.length} characters from ${data.numpages} pages`);

      const cleaned = data.text
        .replace(/\r\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();

      documents.push({
        source: source.name,
        source_type: 'icc',
        format: source.format,
        law_number: null,
        law_title: source.name,
        url: source.url,
        content: cleaned,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Failed: ${source.name} - ${msg}`);
    }
  }

  console.log(`\nTotal documents loaded: ${documents.length}`);
  return documents;
}
