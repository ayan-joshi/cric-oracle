import axios from 'axios';
import * as cheerio from 'cheerio';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse');

export interface CrawledPage {
  url: string;
  title: string;
  content: string;
}

const BASE = 'https://www.lords.org';
const LAWS_BASE = '/mcc/the-laws-of-cricket-2d35b4b95a4a67ae8f9c76f258a84aa8';

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

const ICC_PDFS = [
  {
    name: 'ICC Test Match Playing Conditions',
    url: 'https://images.icc-cricket.com/image/upload/prd/lm8owaz03i86m1eneb7m.pdf',
  },
  {
    name: 'ICC ODI Playing Conditions',
    url: 'https://images.icc-cricket.com/image/upload/prd/d25dbgishkx0kijb4jeu.pdf',
  },
  {
    name: 'ICC T20I Playing Conditions',
    url: 'https://images.icc-cricket.com/image/upload/prd/qfnsie8fz6vhyl1pmcli.pdf',
  },
];

async function fetchPage(url: string): Promise<string> {
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CricOracle/1.0; educational project)' },
    timeout: 15000,
  });
  return response.data;
}

async function downloadPDF(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CricOracle/1.0; educational project)' },
    timeout: 60000,
  });
  return Buffer.from(response.data);
}

function extractLawText($: cheerio.CheerioAPI, url: string): CrawledPage {
  // Remove clutter
  $('nav, header, footer, script, style, .navigation, .breadcrumb, .cookie, [class*="cookie"], [class*="nav"], [class*="header"], [class*="footer"], iframe, noscript').remove();

  const title = $('h1').first().text().trim() || url.split('/').pop() || url;

  // Try content containers from most to least specific
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

  return { url: 'MCC Laws of Cricket (2017 Code, 3rd Edition 2022)', title, content };
}

export async function crawlLaws(): Promise<CrawledPage[]> {
  const allPages: CrawledPage[] = [];

  // --- Step 1: Scrape individual MCC law pages from lords.org ---
  console.log(`\nScraping ${LAW_PATHS.length} MCC law pages from lords.org...`);
  let scraped = 0;

  for (const path of LAW_PATHS) {
    const url = BASE + LAWS_BASE + path;
    try {
      const html = await fetchPage(url);
      const $ = cheerio.load(html);
      const page = extractLawText($, url);

      if (page.content.length > 100) {
        allPages.push(page);
        scraped++;
      }

      await new Promise((r) => setTimeout(r, 400));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Failed: ${path.split('/').pop()} — ${msg}`);
    }
  }

  console.log(`  Scraped ${scraped}/${LAW_PATHS.length} law pages`);

  // --- Step 2: Download ICC Playing Conditions PDFs ---
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

      allPages.push({ url: source.name, title: source.name, content: cleaned });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Failed: ${source.name} — ${msg}`);
    }
  }

  console.log(`\nTotal documents loaded: ${allPages.length}`);
  return allPages;
}
