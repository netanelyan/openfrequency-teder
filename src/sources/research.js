import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getJson } from '../core/net.js';
import { nowIso } from '../core/clock.js';
import { j } from '../db/index.js';
import { htmlToText } from './text.js';
import { wikipediaDocs } from './index.js';

// Research: more documents about one topic, read before a post is drafted.
//
// A post drafted from one document tells what everyone knows. The details a fan
// keeps (who said what, the minute, the moment, what came before, what people said
// after) are in the article about the match, the fight or the launch itself, not
// in the list the topic came from. The outline names those articles (its
// `research` terms); this module finds and stores them, so every detail drafted
// from them is checked against its stored text like any other fact.
//
// It reads only through the pack's own approved sources: a term is searched in
// the Wikipedia of an approved Wikipedia source (in that source's language), and
// in Hacker News when the pack has an approved Hacker News source. Each document
// found is stored under that source, so the slide's source line and the fact's
// trace lead back to an approved source like everything else.
//
// An account whose sources include no Wikipedia (every account the setup makes) gets one
// of its own the first time research runs (researchWiki): an approved source on its
// Sources page, the account's to remove.
//
// Offline, research reads <pack>/recordings/research/<document key>.json
// ({ docs: [{ url, title, text }] }) or finds nothing.

const MAX_DOC = 9000;
const INFOBOX_MAX = 3000;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const HEBREW = /[֐-׿]/;

/** The approved sources research may read through, by kind. A source may read several Wikipedias (api.langs). */
export function researchSources(db, pack) {
  const rows = db.all("SELECT * FROM sources WHERE account_id = ? AND status = 'approved' ORDER BY id", pack.id);
  const wiki = {};
  let hn = null;
  for (const r of rows) {
    const api = j(r.config_json, {})?.api || {};
    if (api.kind === 'wikipedia') for (const lang of api.langs?.length ? api.langs : [api.lang || r.lang || 'en']) wiki[lang] ??= r;
    if (api.kind === 'hn') hn ??= r;
  }
  return { wiki, hn };
}

/** The key of the Wikipedia an account's research reads when its own sources name none. */
export const WIKI_KEY = 'wikipedia-research';

/**
 * The Wikipedia an account's research reads when none of its approved sources is one: a source of the account like
 * any other, approved when it is made (the first time research runs for the account), on its Sources page, the
 * account's to remove there, and never made again once removed. It reads the account's own language and English, and
 * nothing on its own: only the articles a post's outline names (candidateDocs leaves it out).
 *
 * Why a source and not a free read: every fact is quoted from a document of an approved source, and a slide's source
 * line and a fact's trace lead back to one. An account made by the setup had none of the kinds research reads
 * (Wikipedia, Hacker News), so research found nothing for any new customer and the details rule, meant to be fed by
 * it, dropped their topics instead (2026-11-06). Returns the row, or null when the account removed it or the pack
 * says research.wikipedia: false.
 */
export function researchWiki(db, pack) {
  const have = db.get('SELECT * FROM sources WHERE account_id = ? AND key = ?', pack.id, WIKI_KEY);
  if (have) return have.status === 'approved' ? have : null;
  if (pack.meta?.research?.wikipedia === false) return null;
  const lang = /^[a-z]{2}$/.test(pack.meta?.language || '') ? pack.meta.language : 'he';
  const at = nowIso();
  db.insert('sources', {
    account_id: pack.id, key: WIKI_KEY, type: 'api', url: `https://${lang}.wikipedia.org/`, name: lang === 'he' ? 'ויקיפדיה' : 'Wikipedia', lang, status: 'approved', origin: 'discovered', approved_at: at, created_at: at,
    why: 'ערכים של ויקיפדיה על הנושא של כל פוסט, בעברית ובאנגלית: מהם באים הפרטים שמעבר למסמך, וכל פרט נבדק מול הערך עצמו.',
    config_json: { api: { kind: 'wikipedia', research: true, langs: [...new Set([lang, 'en'])] } },
  });
  return db.get('SELECT * FROM sources WHERE account_id = ? AND key = ?', pack.id, WIKI_KEY);
}

/**
 * The part of a long text about the subject: its paragraphs that name the
 * subject or hold a number or a quotation, best first, put back in the text's own
 * order, up to maxChars.
 */
export function aboutSubject(text, names = [], maxChars = MAX_DOC) {
  const paras = String(text || '').split(/\n{1,}/).map((p) => p.trim()).filter((p) => p.length > 30);
  const words = names.map((n) => String(n).toLowerCase()).filter((n) => n.length >= 3);
  const score = (p) => {
    const t = p.toLowerCase();
    return words.filter((w) => t.includes(w)).length * 3 + (/\d/.test(p) ? 1 : 0) + (/["“”«»]/.test(p) ? 2 : 0) + (/^==/.test(p) ? -5 : 0);
  };
  const ranked = paras.map((p, i) => ({ p, i, s: score(p) })).sort((a, b) => b.s - a.s || a.i - b.i);
  const keep = new Set();
  let size = 0;
  for (const r of ranked) {
    if (size + r.p.length + 1 > maxChars) continue;
    keep.add(r.i);
    size += r.p.length + 1;
  }
  return paras.filter((_, i) => keep.has(i)).join('\n');
}

/** Store a research document under its source, as refreshSource stores any document. */
function store(db, src, d, recorded = false) {
  const text = String(d.text || '').trim();
  if (text.length < 200) return null;
  const hash = sha(text);
  const have = db.get('SELECT * FROM documents WHERE source_id = ? AND sha256 = ?', src.id, hash);
  if (have) return have;
  const id = db.insert('documents', { source_id: src.id, key: d.key || null, url: d.url, title: d.title || null, text, sha256: hash, published_at: d.publishedAt || null, fetched_at: nowIso(), recorded: recorded ? 1 : 0 });
  return db.get('SELECT * FROM documents WHERE id = ?', id);
}

/** A Wikipedia title for a search term, through the search API of that language. */
async function wikiTitle(lang, term) {
  const q = new URLSearchParams({ action: 'query', list: 'search', srsearch: term, srlimit: '1', srnamespace: '0', format: 'json', formatversion: '2' });
  const body = await getJson(`https://${lang}.wikipedia.org/w/api.php?${q}`);
  return body?.query?.search?.[0]?.title || null;
}

/** Show HN posts for a term, through the Algolia HN Search API: the founder's own text, with its points and date. */
export async function hnDocs(term, { max = 2 } = {}) {
  const q = new URLSearchParams({ query: term, tags: 'show_hn', hitsPerPage: String(max) });
  const body = await getJson(`https://hn.algolia.com/api/v1/search?${q}`);
  return (body?.hits || [])
    .filter((h) => h.story_text || h.title)
    .map((h) => ({
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: `${h.title} (Hacker News)`,
      text: [h.title, htmlToText(h.story_text || ''), `points: ${h.points ?? ''} | comments: ${h.num_comments ?? ''} | posted: ${String(h.created_at || '').slice(0, 10)}`].filter(Boolean).join('\n'),
      publishedAt: h.created_at || null,
    }));
}

/**
 * The research documents for one topic: up to `max` new documents, stored, each
 * narrowed to the part about the subject. `have` holds the urls of the documents
 * the post already has. Returns [{ ...document row, text narrowed }].
 */
export async function research(ctx, { pack, terms = [], names = [], have = [], max = 3, docKey = null }) {
  const { db } = ctx;
  let srcs = researchSources(db, pack);
  // Live, an account none of whose sources is a Wikipedia reads its own (researchWiki), once there is a term to look up.
  if (ctx.mode !== 'recorded' && terms.length && !Object.keys(srcs.wiki).length && researchWiki(db, pack)) srcs = researchSources(db, pack);
  const seen = new Set(have.map((u) => String(u).toLowerCase()));
  const out = [];
  // head: the start of the stored text kept whole (an infobox's rows are too short for aboutSubject to keep).
  const keep = (row, head = '') => {
    if (!row || seen.has(String(row.url).toLowerCase())) return;
    seen.add(String(row.url).toLowerCase());
    out.push({ ...row, text: head ? `${head}\n${aboutSubject(row.text.slice(head.length), names, MAX_DOC - head.length)}` : aboutSubject(row.text, names) });
  };
  if (ctx.mode === 'recorded') {
    const file = docKey ? path.join(pack.recordingsDir, 'research', `${docKey}.json`) : null;
    const src = Object.values(srcs.wiki)[0] || srcs.hn;
    if (!file || !src || !existsSync(file)) return out;
    for (const d of JSON.parse(readFileSync(file, 'utf8')).docs || []) if (out.length < max) keep(store(db, src, d, true));
    return out;
  }
  for (const term of terms.slice(0, 4)) {
    if (out.length >= max) break;
    const lang = HEBREW.test(term) && srcs.wiki.he ? 'he' : srcs.wiki.en ? 'en' : Object.keys(srcs.wiki)[0];
    try {
      if (lang) {
        const title = await wikiTitle(lang, term);
        if (title) {
          const src = srcs.wiki[lang];
          const [doc] = await wikipediaDocs(src, { kind: 'wikipedia', lang, titles: [title] });
          // The lead from the page's HTML carries the infobox (a fighter's wins, losses and finishes), which the
          // plain extract drops: a tale of the tape found no record for either fighter.
          const [box] = await wikipediaDocs(src, { kind: 'wikipedia', lang, titles: [`${title}#intro`], mode: 'rest' }).catch(() => []);
          const head = box ? box.text.trim().slice(0, INFOBOX_MAX) : '';
          if (doc) keep(store(db, src, head ? { ...doc, text: `${head}\n\n${doc.text}` } : doc), head);
        }
      }
      if (srcs.hn && out.length < max) for (const d of await hnDocs(term)) keep(store(db, srcs.hn, d));
    } catch (e) {
      ctx.log?.(`research "${term}": ${e.message}`);
    }
  }
  return out;
}
