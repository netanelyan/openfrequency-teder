import { localFetch } from '../core/net.js';
import { TORAN_INTERNAL } from '../notify/operator.js';

// A pitch to a lead on WhatsApp, sent by Toran from our number (the owner, 2026-11-08: "if i press the send button to a
// demo suggestion, i want it to go to whatsapp, so toran should send it"): /leads' "לשלוח בוואטסאפ מהמספר שלנו" asks
// Toran here, and marks the lead sent only when Toran says it went. Toran holds the number, Meta's approved templates
// and every limit shared with its own pitches (its src/ops/outreach.ts): the number that asked to be removed, once a
// stage, the day's cap for both products, no night or Shabbat, and Meta's quality read first.
//
//   POST {OF_TORAN_INTERNAL}/internal/outreach/send, Authorization: Bearer OF_INTERNAL_TOKEN
//   { product: 'teder', stage: 'first' | 'reminder', phone, name, url, ref, by }
//   -> 200 { ok: true, sent, why, said }   said is Toran's Hebrew line for the operator, whatever happened
//
// The contract is test/fixtures/outreach-send.json, the same file in Toran. Only this machine is asked (localFetch).
// Never throws: Toran down or refusing is { sent: false, why: 'unreachable', said }.

export const OUTREACH_PATH = '/internal/outreach/send';
const TIMEOUT_MS = 20_000;
const MIN_TOKEN = 32;

export const UNREACHABLE = 'לא הצלחנו להגיע לתורן, שהוא זה ששולח מהמספר שלנו. שום דבר לא נשלח ולא סומן. אפשר לנסות שוב בעוד רגע, או להעתיק את ההודעה ולשלוח מהטלפון.';

/** Where the pitch is handed to Toran, or null when OF_TORAN_INTERNAL is off. */
export function outreachUrl(env = process.env) {
  const v = String(env.OF_TORAN_INTERNAL || '').trim();
  if (v.toLowerCase() === 'off') return null;
  return `${(v || TORAN_INTERNAL).replace(/\/+$/, '')}${OUTREACH_PATH}`;
}

/** Whether a pitch can be handed to Toran from here at all (its address and the shared token are set). */
export const outreachOn = (env = process.env) => Boolean(outreachUrl(env)) && String(env.OF_INTERNAL_TOKEN || '').trim().length >= MIN_TOKEN;

/** One pitch to Toran. { sent, why, said }. */
export async function sendPitch(ctx, pitch, { env = process.env, fetchImpl = localFetch } = {}) {
  const url = outreachUrl(env);
  const token = String(env.OF_INTERNAL_TOKEN || '').trim();
  if (!url || token.length < MIN_TOKEN) return { sent: false, why: 'unreachable', said: UNREACHABLE };
  try {
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ product: 'teder', ...pitch }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let answer = null;
    try {
      answer = await r.json();
    } catch {
      /* the status says enough */
    }
    if (r.status !== 200 || !answer || typeof answer.sent !== 'boolean') {
      ctx.log?.(`[leads] Toran did not take the pitch for ${pitch.ref}: HTTP ${r.status}${answer?.error ? ` ${answer.error}` : ''}`);
      return { sent: false, why: 'unreachable', said: UNREACHABLE };
    }
    return { sent: answer.sent, why: answer.why ?? null, said: String(answer.said || '') || (answer.sent ? 'נשלח.' : 'לא נשלח.') };
  } catch (e) {
    ctx.log?.(`[leads] Toran did not take the pitch for ${pitch.ref}: ${e.message}`);
    return { sent: false, why: 'unreachable', said: UNREACHABLE };
  }
}
