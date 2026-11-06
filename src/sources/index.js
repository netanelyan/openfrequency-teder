import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getJson, getText } from '../core/net.js';
import { now, nowIso } from '../core/clock.js';
import { j } from '../db/index.js';
import { israelDate } from '../schedule/israel.js';
import { parseFeed } from './rss.js';
import { htmlToText, labelTables, mainHtml, titleOf, unreadable } from './text.js';
import { packsDir } from '../core/paths.js';
import { parseCsv } from './csv.js';
import { factDocuments, factsDir } from './facts.js';
import { robotsAllows } from './robots.js';

// Sources, behind one interface: read(source) -> [{ url, title, text, publishedAt, key? }].
//
//   rss   a feed; short items are completed from their own page
//   web   one page, narrowed to its main content (hints.selector), optionally
//         following links from an index page (hints.follow)
//   api   structured data, each record one line of "field: value" so its
//         numbers can be quoted exactly. api.kind says which:
//           json             any JSON endpoint (api.path to the records, api.fields)
//           wikidata-sparql  a SPARQL query
//           csv              a CSV file (government datasets; api.encoding when
//                            not UTF-8), with api.changesOnly to keep only the rows
//                            where a series changed (a rate, daily)
//           ckan             a data.gov.il datastore resource, through CKAN's own
//                            datastore_search API
//           facts            the pack's hand-checked facts (facts.js), one document
//                            per topic, each expiring with its earliest fact
//
// The recorded implementation reads <pack>/recordings/documents/*.json instead,
// so the pipeline runs offline on documents that were really fetched once.
//
// A feed or a page is read only where its site's robots.txt lets this engine in, and lets Claude in too
// (robots.js): an item whose article sits on a page Claude is told to stay out of is dropped, feed text and all.
//
// hints.prefer, a pattern, puts a feed's long reads first ("interview", "feature", "ראיון"): a feed of match
// reports and transfer rumours gives the writer little to tell, and the items that match go to the top before the
// first few are taken.
//
// Every document is stored with its full text and a hash. That stored text is
// what every quote is checked against, then and later, so a post can be
// re-verified after the page has changed.

const MAX_TEXT = 16_000;
/** A source may keep more of a long page (a docs page whose price table is past the first 16,000 characters): hints.maxChars, up to 60,000. */
const maxOf = (hints = {}) => Math.min(60_000, Number(hints.maxChars) || MAX_TEXT);
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

/**
 * A dated list, narrowed to one day of the year: the lines that carry the day the
 * post goes out on, written the source's way (hints.onlyDay "DD/MM/" keeps
 * "27/10/2001 Austria Home 1-1"). What an on-this-day post is drafted from.
 */
export function onlyDay(text, day, pattern) {
  const [, , mm, dd] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '') || [];
  if (!mm) return text;
  const want = pattern.replace('DD', dd).replace('MM', mm).replace('D', String(Number(dd))).replace('M', String(Number(mm)));
  // The page's own first lines stay as the header, so the document says what its lines are.
  const lines = String(text || '').split('\n');
  return [...lines.slice(0, 3), ...lines.slice(3).filter((l) => l.includes(want))].join('\n');
}

export function liveSources() {
  return {
    kind: 'live',
    async read(src, { day = null, events = [] } = {}) {
      const cfg = j(src.config_json, {}) || {};
      const hints = cfg.hints || {};
      const forDay = (text) => (hints.onlyDay ? onlyDay(text, day || israelDate(now()), hints.onlyDay) : text);
      if (src.type === 'rss') {
        await mayRead(src.url);
        const { body } = await getText(src.url, { accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' });
        const items = preferred(parseFeed(body), hints.prefer).slice(0, hints.max || 6);
        const out = [];
        for (const it of items) {
          if (it.url && !(await robotsAllows(it.url)).ok) continue;
          let text = it.text;
          if (text.length < (hints.minFeedChars || 800) && hints.fetchItems !== false) {
            try {
              const page = await getText(it.url);
              text = htmlToText(mainHtml(page.body, hints.selector));
            } catch {
              /* the feed's own text stands */
            }
          }
          out.push({ ...it, text: text.slice(0, MAX_TEXT) });
        }
        return out;
      }
      if (src.type === 'web') {
        await mayRead(src.url);
        // Some old pages are Latin-1 (RSSSF): hints.encoding reads them as written.
        const page = await getText(src.url, { encoding: hints.encoding || null });
        const docs = [{ url: page.finalUrl, title: titleOf(page.body), text: forDay(labelTables(htmlToText(mainHtml(page.body, hints.selector)))).slice(0, maxOf(hints)), publishedAt: null }];
        if (hints.follow?.pattern) {
          const re = new RegExp(hints.follow.pattern, 'i');
          const links = [...new Set([...page.body.matchAll(/href=["']([^"']+)["']/gi)].map((m) => new URL(m[1], page.finalUrl).href).filter((u) => re.test(u)))];
          for (const url of links.slice(0, hints.follow.max || 5)) {
            if (!(await robotsAllows(url)).ok) continue;
            try {
              const p = await getText(url, { encoding: hints.encoding || null });
              docs.push({ url: p.finalUrl, title: titleOf(p.body), text: forDay(htmlToText(mainHtml(p.body, hints.selector))).slice(0, MAX_TEXT), publishedAt: null });
            } catch {
              /* one dead link is not a dead source */
            }
          }
        }
        return docs;
      }
      if (src.type === 'api') return fetchApi(src, cfg, { day, events });
      throw new Error(`unknown source type ${src.type}`);
    },
  };
}

/** A source's own address, refused when its robots.txt keeps this engine or Claude out: the source shows why. */
async function mayRead(url) {
  const r = await robotsAllows(url);
  if (!r.ok) throw new Error(r.why);
}

/** A feed's items with the ones its pattern names first, in their order, then the rest. Pure. */
export function preferred(items, pattern) {
  if (!pattern) return items;
  const re = new RegExp(pattern, 'i');
  const hit = (it) => re.test(`${it.title || ''} ${it.url || ''} ${String(it.text || '').slice(0, 400)}`);
  return [...items.filter(hit), ...items.filter((it) => !hit(it))];
}

/** A query's {MONTH} and {DAY}: the post's day, so a birthday query asks about the day the post goes out. */
const dayInQuery = (q, day) => {
  const [, , mm, dd] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '') || [];
  return mm ? String(q).replace(/\{MONTH\}/g, String(Number(mm))).replace(/\{DAY\}/g, String(Number(dd))) : String(q);
};

/** Headers a source asks for: SEC's EDGAR wants a User-Agent naming who reads and how to reach them (api.uaEnv names the .env variable). */
function apiHeaders(api) {
  const h = { ...(api.headers || {}) };
  if (api.uaEnv) {
    const ua = String(process.env[api.uaEnv] || '').trim();
    if (!ua) throw new Error(`${api.uaEnv} is not set in .env: this source wants a User-Agent with a contact`);
    h['user-agent'] = ua;
  }
  return h;
}

async function fetchApi(src, cfg, { day = null, events = [] } = {}) {
  const api = cfg.api || {};
  if (api.kind === 'wikidata-sparql') {
    const url = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(dayInQuery(api.query, day || israelDate(now())))}`;
    const body = await getJson(url, { headers: { accept: 'application/sparql-results+json' } });
    const vars = body?.head?.vars || [];
    const lines = (body?.results?.bindings || []).map((b) => vars.map((v) => `${v}: ${b[v]?.value ?? ''}`).join(' | '));
    return [{ url: src.url, title: api.title || src.name, text: lines.join('\n').slice(0, MAX_TEXT), publishedAt: null }];
  }
  if (api.kind === 'facts') return factDocuments(factsDir(src.account_id));
  if (api.kind === 'bank') return bankDocs(src, api);
  // Research's own Wikipedia (src/sources/research.js researchWiki) names no article: it reads only what an outline asks for.
  if (api.kind === 'wikipedia' && !api.titles && !api.title) return [];
  // "{EVENTS}" among a Wikipedia source's titles: the pages of the events this week (a fight card).
  if (api.kind === 'wikipedia') return wikipediaDocs(src, { ...api, titles: (api.titles || [api.title]).flatMap((x) => (x === '{EVENTS}' ? events : [x])) });
  if (api.kind === 'csv') {
    const { body } = await getText(api.url || src.url, { accept: 'text/csv,text/plain;q=0.9,*/*;q=0.5', encoding: api.encoding || null });
    let rows = parseCsv(body, { delimiter: api.delimiter || null });
    for (const [k, v] of Object.entries(api.filter || {})) rows = rows.filter((r) => String(r[k]) === String(v));
    if (api.changesOnly) rows = changesOf(rows, api.changesOnly, api.seriesBy);
    if (api.last) rows = rows.slice(-api.last);
    return [{ url: src.url, title: api.title || src.name, text: linesOf(rows, api).join('\n').slice(0, MAX_TEXT), publishedAt: null }];
  }
  if (api.kind === 'ckan') {
    // data.gov.il's own CKAN API: the dataset's datastore, as JSON.
    const q = new URLSearchParams({ resource_id: api.resource, limit: String(api.limit || 100), ...(api.sort ? { sort: api.sort } : {}), ...(api.filters ? { filters: JSON.stringify(api.filters) } : {}) });
    const body = await getJson(`${api.base || 'https://data.gov.il/api/3/action'}/datastore_search?${q}`);
    if (!body?.success) throw new Error(`data.gov.il: ${body?.error?.message || 'the datastore answered without success'}`);
    let rows = body.result?.records || [];
    if (api.changesOnly) rows = changesOf(rows, api.changesOnly, api.seriesBy);
    if (api.last) rows = rows.slice(-api.last);
    return [{ url: src.url, title: api.title || src.name, text: linesOf(rows, api).join('\n').slice(0, MAX_TEXT), publishedAt: null }];
  }
  // A JSON endpoint: each record becomes one line of "field: value", which keeps
  // the numbers quotable verbatim.
  const body = await getJson(api.url || src.url, { headers: apiHeaders(api) });
  const records = api.path ? api.path.split('.').reduce((o, k) => o?.[k], body) : body;
  let list = Array.isArray(records) ? records : [records];
  // api.where keeps the records that have a value there (a fixture list, only the games played);
  // api.last keeps the newest.
  const get = (r, f) => f.split('.').reduce((o, k) => o?.[k], r);
  if (api.where) list = list.filter((r) => { const v = get(r, api.where); return v != null && v !== '' && !(Array.isArray(v) && !v.length); });
  if (api.last) list = list.slice(-api.last);
  // api.each: one document per record (a Hacker News post), with its own address, so a slide's source is that post.
  if (api.each) {
    return list.slice(0, api.max || 20).map((r) => ({
      url: String(api.each.url || src.url).replace(/\{([\w.]+)\}/g, (_, f) => encodeURIComponent(String(get(r, f) ?? ''))),
      title: plainValue(get(r, api.each.title || 'title')) || src.name,
      text: linesOf([r], api).join('\n').slice(0, MAX_TEXT),
      publishedAt: api.each.date ? get(r, api.each.date) || null : null,
    }));
  }
  return [{ url: src.url, title: api.title || src.name, text: linesOf(list.slice(0, api.max || 200), api).join('\n').slice(0, MAX_TEXT), publishedAt: null }];
}

/** A Wikipedia article's address, from its title. */
export const wikiUrl = (lang, title) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(title).replace(/ /g, '_'))}`;

/**
 * The part of a plain-text extract under the given section headings ("== History
 * =="), each down to the next heading of the same or a higher level. Without
 * sections, the whole text.
 */
export function wikiSections(text, sections = []) {
  const s = String(text || '');
  if (!sections.length) return s.replace(/^=+\s*(.*?)\s*=+$/gm, '$1').trim();
  const out = [];
  const lines = s.split('\n');
  for (const want of sections) {
    // "intro" is the lead, the text above the first heading: a long article's summary, kept beside a section further down.
    if (/^intro$/i.test(want)) {
      const end = lines.findIndex((l) => /^=+\s*.*?\s*=+$/.test(l.trim()));
      out.push(lines.slice(0, end < 0 ? lines.length : end).join('\n').trim());
      continue;
    }
    const i = lines.findIndex((l) => new RegExp(`^(=+)\\s*${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=+$`, 'i').test(l.trim()));
    if (i < 0) continue;
    const level = /^(=+)/.exec(lines[i].trim())[1].length;
    const body = [lines[i].replace(/=+/g, '').trim()];
    for (let k = i + 1; k < lines.length; k++) {
      const h = /^(=+)\s*(.*?)\s*=+$/.exec(lines[k].trim());
      if (h && h[1].length <= level) break;
      body.push(h ? h[2] : lines[k]);
    }
    out.push(body.join('\n').trim());
  }
  return out.join('\n\n');
}

/** A rendered wiki page to text, each table row on one line ("a | b | c") so a row can be quoted as it reads. */
export function wikiHtmlToText(html) {
  let s = String(html || '').replace(/<span[^>]*class="[^"]*mw-editsection[^"]*"[^>]*>[\s\S]*?<\/span>\s*<\/span>|<span[^>]*class="[^"]*mw-editsection[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
  s = s.replace(/<sup[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, '');
  // Each table's rows labelled with its header row, so a row quoted alone says which value is which.
  s = s.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    let names = null;
    return table.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
      const cells = row.split(/<\/t[dh]>/i).map((c) => htmlToText(c).replace(/\n+/g, ' ').trim()).filter(Boolean);
      const header = /<th\b/i.test(row) && !/<td\b/i.test(row);
      if (header && !names) names = cells.map((c) => c.slice(0, 40));
      const labelled = !header && names && cells.length === names.length && names.every(Boolean) ? cells.map((c, k) => `${names[k]}: ${c}`) : cells;
      return `<p>${labelled.join(' | ').replace(/</g, '&lt;')}</p>`;
    });
  });
  return htmlToText(s);
}

/**
 * One section of a Wikipedia page's REST HTML (Parsoid), by its heading, with its
 * subsections and tables, as text with each table row on one line. "intro" is the
 * lead. Null when the page has no such section.
 */
export function restSection(html, heading) {
  const s = String(html || '');
  if (!heading || heading === 'intro') {
    const m = /<section[^>]*data-mw-section-id="0"[^>]*>([\s\S]*?)<\/section>/.exec(s);
    return m ? wikiHtmlToText(m[1]) : null;
  }
  const want = String(heading).trim().toLowerCase();
  for (const m of s.matchAll(/<section\b[^>]*data-mw-section-id="(-?\d+)"[^>]*>\s*<h([2-6])\b[^>]*>([\s\S]*?)<\/h\2>/g)) {
    if (htmlToText(m[3]).trim().toLowerCase() !== want) continue;
    let depth = 0;
    let end = s.length;
    const re = /<\/?section\b[^>]*>/g;
    re.lastIndex = m.index;
    for (let x; (x = re.exec(s)); ) {
      depth += x[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        end = x.index;
        break;
      }
    }
    return wikiHtmlToText(s.slice(m.index, end));
  }
  return null;
}

/**
 * Wikipedia through its own API, never the page: one document per title, as
 * plain text (api.mode "extract", the default: TextExtracts, no tables) or from
 * the REST page HTML with its tables (api.mode "rest"). api.sections narrows each
 * to those sections, and so does a title written "Title#Section" or "Title#intro;Section" (that title only).
 * Titles read together (api.group) are one candidate for a post, as two articles
 * for a head-to-head are.
 */
export async function wikipediaDocs(src, api) {
  const lang = api.lang || src.lang || 'en';
  const base = `https://${lang}.wikipedia.org/w/api.php`;
  const titles = api.titles || [api.title];
  const docs = [];
  for (const spec of titles) {
    const [title, own] = String(spec).split('#');
    const sections = own ? own.split(';').map((x) => x.trim()).filter(Boolean) : api.sections || [];
    let text = '';
    let resolved = title;
    if ((api.mode || 'extract') === 'extract') {
      const q = new URLSearchParams({ action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'wiki', redirects: '1', format: 'json', formatversion: '2', titles: title });
      const body = await getJson(`${base}?${q}`);
      const page = body?.query?.pages?.[0];
      if (!page || page.missing) throw new Error(`Wikipedia (${lang}): no article "${title}"`);
      resolved = page.title;
      text = wikiSections(page.extract, sections);
    } else {
      // The REST page HTML, the Robot policy's own recommendation for a page's HTML:
      // every section is a <section> there, so one section comes with its tables.
      const html = await getText(`https://${lang}.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(String(title).replace(/ /g, '_'))}`, { accept: 'text/html' });
      resolved = /<title>([^<]*)<\/title>/i.exec(html.body)?.[1]?.replace(/_/g, ' ') || title;
      text = (sections.length ? sections : ['intro'])
        .map((want) => restSection(html.body, want))
        .filter(Boolean)
        .join('\n\n');
    }
    if (!text.trim()) continue;
    docs.push({ url: wikiUrl(lang, resolved), title: `${resolved} (Wikipedia${lang === 'he' ? ' בעברית' : ''})`, text: text.slice(0, MAX_TEXT), publishedAt: null, group: api.group ? `${src.key}:${titles.join('|')}` : null });
  }
  return docs;
}

/**
 * Records to lines of "label: value | label: value". A label (api.labels) says in
 * Hebrew what a coded column is, so the line can be read and quoted as written.
 */
export function linesOf(records, { fields = null, labels = {} } = {}) {
  const keys = fields || Object.keys(records[0] || {});
  const get = (r, f) => f.split('.').reduce((o, k) => o?.[k], r);
  return records.map((r) => keys.map((f) => `${labels[f] || f}: ${plainValue(get(r, f))}`).join(' | '));
}

/**
 * A field's value as text a quote can match: HTML in a JSON field (a Hacker News
 * post's text: "it&#x27;s", "<p>") read as the words it shows, on one line.
 */
export function plainValue(v) {
  if (v == null) return '';
  const s = String(v);
  return /<[a-z/]|&(?:#x?[0-9a-f]+|[a-z]+);/i.test(s) ? htmlToText(s).replace(/\s*\n+\s*/g, ' ').trim() : s;
}

/**
 * The pack's topic bank (<pack>/topics.json): topics someone chose, each with the
 * kind of post it suits and the pages that document it. Each topic's pages are
 * read as one group, so a post is drafted from exactly them, and only by a format
 * of that kind (poolFor). A page is read through its machine door: Hacker News
 * through its API, never as a web page; a Wikipedia article through the MediaWiki
 * API; anything else as its own text.
 */
export async function bankDocs(src, api) {
  const file = path.join(packsDir(), src.account_id, api.file || 'topics.json');
  if (!existsSync(file)) return [];
  const topics = JSON.parse(readFileSync(file, 'utf8'));
  const slug = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 10);
  const docs = [];
  for (const t of (Array.isArray(topics) ? topics : topics.topics || []).slice(0, api.max || 200)) {
    // A topic names the kind of post it is for, or one format of that kind ("format": a crazy-tool story, not any story).
    const group = `bank:${t.format || t.kind}:${slug(t.topic)}`;
    const seen = new Set();
    for (const u of t.urls || []) {
      const hn = /news\.ycombinator\.com\/item\?id=(\d+)|story_(\d+)/.exec(u);
      const id = hn && (hn[1] || hn[2]);
      const key = id ? `hn:${id}` : u;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (id) {
          const item = await getJson(`https://hn.algolia.com/api/v1/items/${id}`);
          const text = [item.title, plainValue(item.text || ''), `points: ${item.points ?? ''} | posted: ${String(item.created_at || '').slice(0, 10)}`].filter(Boolean).join('\n');
          docs.push({ url: `https://news.ycombinator.com/item?id=${id}`, title: `${item.title} (Hacker News)`, text, publishedAt: item.created_at || null, group, key: group });
        } else if (/\.wikipedia\.org\/wiki\//.test(u)) {
          const lang = /^https:\/\/(\w+)\./.exec(u)[1];
          const title = decodeURIComponent(u.split('/wiki/')[1]).replace(/_/g, ' ');
          // A link that names its sections ("Jon_Jones#intro;Championships_and_accomplishments") is read from the page's
          // HTML: the lead comes with its infobox (a fighter's record) and a section with its tables, which the plain
          // extract drops. A long article's numbers sit past the cut, in those sections.
          const mode = title.includes('#') ? 'rest' : 'extract';
          for (const d of await wikipediaDocs({ ...src, lang }, { kind: 'wikipedia', lang, titles: [title], mode })) docs.push({ ...d, group, key: group });
        } else {
          const page = await getText(u);
          const text = labelTables(/\.md(\.txt)?$/.test(new URL(u).pathname) ? page.body : htmlToText(mainHtml(page.body)));
          docs.push({ url: u, title: titleOf(page.body) || t.topic, text: text.slice(0, maxOf(api)), publishedAt: null, group, key: group });
        }
      } catch {
        /* one page that cannot be read leaves the topic with the rest */
      }
    }
  }
  return docs;
}

/**
 * The rows where a value changed from the row before, per series, oldest first:
 * a rate that is published daily but changes a few times a year, as its changes.
 * The last row of each series is kept too, so the current value is always there.
 */
export function changesOf(rows, field, seriesBy = null) {
  const out = [];
  const last = new Map();
  rows.forEach((r, i) => {
    const s = seriesBy ? r[seriesBy] : '';
    const isLast = !rows.slice(i + 1).some((x) => (seriesBy ? x[seriesBy] : '') === s);
    if (last.get(s) !== r[field] || isLast) out.push(r);
    last.set(s, r[field]);
  });
  return out;
}

/** Documents recorded for a pack: <pack>/recordings/documents/<key>.json with { source, url, title, text, ... }. */
export function recordedSources(pack) {
  const dir = path.join(pack.recordingsDir, 'documents');
  let all = null;
  const load = () => {
    all ??= existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map((f) => ({ key: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }))
      : [];
    return all;
  };
  return {
    kind: 'recorded',
    async read(src) {
      // The hand-checked facts are the pack's own files, not a network source: read them as they are.
      if (j(src.config_json, {})?.api?.kind === 'facts') return factDocuments(path.join(pack.dir, 'facts'));
      return load()
        .filter((d) => d.source === src.key)
        .map((d) => ({ key: d.key, url: d.url, title: d.title, text: d.text, publishedAt: d.publishedAt || null, fetchedAt: d.fetchedAt || null, group: d.group || null }));
    },
  };
}

/**
 * Fetch one source and store what came back. Returns the stored rows. A source
 * that fails records its error and returns [] rather than failing the run: one
 * dead feed is not a dead account.
 */
export async function refreshSource(db, impl, src, opts = {}) {
  let docs;
  try {
    docs = await impl.read(src, opts);
    db.update('sources', src.id, { last_ok_at: nowIso(), last_error: null });
  } catch (e) {
    db.update('sources', src.id, { last_error: String(e.message).slice(0, 300) });
    return [];
  }
  const out = [];
  for (const d of docs) {
    const text = String(d.text || '').trim();
    // A text that is not text (a PDF's bytes, a page read in the wrong encoding) is never stored: a fact could be
    // "quoted" from nothing anyone can read.
    if (text.length < 80 || unreadable(text)) continue;
    const hash = sha(text);
    let row = db.get('SELECT * FROM documents WHERE source_id = ? AND sha256 = ?', src.id, hash);
    if (!row) {
      const id = db.insert('documents', {
        source_id: src.id,
        key: d.key || null,
        url: d.url,
        title: d.title || null,
        text,
        sha256: hash,
        published_at: d.publishedAt || null,
        fetched_at: d.fetchedAt || nowIso(),
        recorded: impl.kind === 'recorded' ? 1 : 0,
        expires_at: d.expiresAt || null,
        group_key: d.group || null,
      });
      row = db.get('SELECT * FROM documents WHERE id = ?', id);
    } else if ((d.group || null) !== (row.group_key || null)) {
      db.update('documents', row.id, { group_key: d.group || null });
      row = db.get('SELECT * FROM documents WHERE id = ?', row.id);
    }
    out.push(row);
  }
  return out;
}
