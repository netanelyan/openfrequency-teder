import { XMLParser } from 'fast-xml-parser';
import { decodeEntities, htmlToText } from './text.js';

// RSS 2.0, Atom and RDF through one parser: they differ in element names and in
// almost nothing that matters here.

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // The default entity budget rejects ordinary full-text feeds whose summaries
  // escape their HTML; depth is what stops a hostile DTD, so it stays tight.
  processEntities: { enabled: true, maxExpansionDepth: 10, maxTotalExpansions: 200_000, maxExpandedLength: 6_000_000, maxEntityCount: 1000 },
});

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const textOf = (n) => (n == null ? '' : typeof n === 'object' ? String(n['#text'] ?? '') : String(n));

function linkOf(entry) {
  const raw = entry.link;
  if (typeof raw === 'string') return raw.trim();
  const links = arr(raw);
  const chosen = links.find((l) => l && typeof l === 'object' && (l['@_rel'] === 'alternate' || !l['@_rel'])) || links[0];
  if (!chosen) return String(entry.guid?.['#text'] || entry.guid || '').trim();
  return typeof chosen === 'string' ? chosen.trim() : String(chosen['@_href'] || chosen['#text'] || '').trim();
}

function dateOf(entry) {
  const s = textOf(entry.pubDate || entry.published || entry.updated || entry['dc:date'] || entry.date);
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Parse a feed body into items { url, title, text, publishedAt }. Throws only when it is not a feed. */
export function parseFeed(body) {
  let doc;
  try {
    doc = parser.parse(String(body || ''));
  } catch (e) {
    throw new Error(`unparseable feed: ${e.message}`);
  }
  const entries = doc?.rss?.channel ? arr(doc.rss.channel.item) : doc?.feed ? arr(doc.feed.entry) : doc?.['rdf:RDF'] ? arr(doc['rdf:RDF'].item) : null;
  if (!entries) throw new Error('not an RSS, Atom or RDF feed');
  return entries
    .map((e) => {
      const url = linkOf(e);
      const title = htmlToText(decodeEntities(textOf(e.title))).trim();
      const raw = textOf(e['content:encoded'] ?? e.content ?? e.description ?? e.summary);
      return url && title ? { url, title, text: htmlToText(decodeEntities(raw)), publishedAt: dateOf(e) } : null;
    })
    .filter(Boolean);
}

/** The feeds a page declares about itself (<link rel="alternate" type="...rss|atom...">). */
// A feed's title without the word the site adds for the feed ("My Jewish Learning » Feed", "Ynet - RSS", "Site Comments
// Feed"): a slide's source line names the site, not its feed (2026-11-07).
export const feedName = (t) => String(t || '').replace(/\s*[»|:\-–•·]\s*(?:comments?\s+)?(?:feed|rss|atom)\s*$/i, '').replace(/\s+(?:comments?\s+)?(?:feed|rss)\s*$/i, '').trim() || String(t || '').trim();

export function declaredFeeds(html, base) {
  const out = [];
  for (const tag of String(html || '').match(/<link\b[^>]*>/gi) || []) {
    const attr = (name) => tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(2).find(Boolean) || '';
    if (!/alternate/i.test(attr('rel')) || !/(rss|atom)\+xml|application\/(rss|atom)/i.test(attr('type'))) continue;
    try {
      const url = new URL(attr('href'), base).href;
      // A feed's title is decoded until it is text: "My Jewish Learning &raquo; Feed" became a source's name (2026-11-06), and some sites encode it twice.
      if (!out.some((f) => f.url === url)) out.push({ url, title: feedName(decodeEntities(decodeEntities(attr('title')))), type: attr('type') });
    } catch {
      /* a broken href is not a feed */
    }
  }
  return out;
}
