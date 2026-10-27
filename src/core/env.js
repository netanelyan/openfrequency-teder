import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ofHome } from './paths.js';

// Keys live in $OF_HOME/.env and nowhere else. A tiny parser rather than a
// dependency: KEY=value lines, # comments, optional quotes. Values already in the
// environment win, so a systemd unit or a test can override a file.

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

let loaded = false;

/** Load $OF_HOME/.env into process.env once. Returns the file's path, or null. */
export function loadEnv(env = process.env) {
  if (loaded) return null;
  loaded = true;
  const file = path.join(ofHome(env), '.env');
  if (!existsSync(file)) return null;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (env[k] === undefined) env[k] = v;
  }
  return file;
}

/** Is a key set (non-empty)? Never returns the value. */
export const isSet = (name, env = process.env) => Boolean(String(env[name] || '').trim());

/**
 * Every variable the engine reads, grouped, for the Settings page and the
 * check that .env.example lists them all. The values are never shown anywhere.
 */
export const KEYS = [
  { name: 'ANTHROPIC_API_KEY', group: 'drafting', what: 'Claude: drafting, review, scoring', he: 'Claude: כתיבה, בדיקת "נשמע כמו בוט", דירוג מקורות' },
  { name: 'ANTHROPIC_WORKSPACE_ID', group: 'drafting', what: 'The workspace, for a key not scoped to one', he: 'מזהה ה-workspace, למפתח שלא שייך לאחד' },
  { name: 'ZERNIO_API_KEY', group: 'publishing', what: 'Zernio: publishing to TikTok, and analytics', he: 'Zernio: פרסום לטיקטוק ונתונים' },
  { name: 'META_APP_ID', group: 'publishing', what: "Meta app id: making and checking Instagram tokens", he: 'מזהה האפליקציה של Meta: יצירה ובדיקה של אסימוני אינסטגרם' },
  { name: 'META_APP_SECRET', group: 'publishing', what: "Meta app secret: making and checking Instagram tokens", he: 'הסוד של אפליקציית Meta' },
  { name: 'BRAVE_API_KEY', group: 'discovery', what: 'Brave Search: finding sources for a new account', he: 'Brave: חיפוש מקורות לחשבון חדש' },
  { name: 'YOUTUBE_API_KEY', group: 'discovery', what: 'YouTube Data API: formats that work now', he: 'YouTube: פורמטים שעובדים עכשיו, עם מספרים אמיתיים' },
  { name: 'PEXELS_API_KEY', group: 'images', what: 'Pexels photographs', he: 'Pexels: תמונות ברישיון' },
  { name: 'UNSPLASH_ACCESS_KEY', group: 'images', what: 'Unsplash photographs', he: 'Unsplash: תמונות ברישיון' },
  { name: 'OPENVERSE_TOKEN', group: 'images', what: 'Openverse: a higher allowance than the anonymous one (optional)', he: 'Openverse: מכסה גבוהה יותר מהאנונימית (לא חובה)' },
  { name: 'SESSION_SECRET', group: 'website', what: "signs the forms' CSRF tokens", he: 'חתימה על הטפסים באתר' },
  { name: 'OF_INTERNAL_TOKEN', group: 'website', what: 'asks openfrequency-accounts who is signed in, and lets the website hand in a demo request', he: 'הבדיקה מול שירות הכניסה מי נכנס, ובקשות לדמו שמגיעות מהאתר' },
  { name: 'OF_ASSISTANT_SECRET', group: 'website', what: 'signs what Teder and the WhatsApp assistant (openfrequency-toran) send each other', he: 'החתימה בין תדר לבין העוזר בוואטסאפ' },
  { name: 'OF_TORAN_URL', group: 'website', what: "where the WhatsApp assistant takes Teder's events, on this machine", he: 'הכתובת שבה העוזר בוואטסאפ מקבל את ההודעות מתדר' },
];
