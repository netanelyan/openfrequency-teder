// What a customer reads when a post did not go out, or a connect did not take: Hebrew, short, and what to do next.
// The publisher's own words (Zernio's, Meta's) go to the log and the post's steps, never to the customer: they are
// English, they name codes, and they are written for us.

const NAME = { tiktok: 'טיקטוק', instagram: 'אינסטגרם' };
const nameOf = (platform) => NAME[platform] || 'הפלטפורמה';

/** Said on a post that was cut off mid-send (src/autonomy/runner.js): it may be out, so a person looks before trying again. */
export const STUCK_REASON = 'השליחה נקטעה באמצע, ולא ברור אם המצגת עלתה. בדקו בפרופיל לפני שמנסים שוב.';

/** Said when the fact gate stops a post at its send: the details (which fact, why) are in the post's steps. */
export const FACT_CHECK_HE = 'בדיקת העובדות עצרה את המצגת לפני השליחה: עובדה בה כבר לא תואמת למקור שלה, או שהמקור הוסר. המצגת לא תעלה.';

/**
 * A send refused before anything went (src/publish/index.js PublishRefused), by its code. The ones whose message is
 * already the customer's (Shabbat, a pause, a photograph to look at) keep it.
 */
const REFUSED_HE = {
  fact_check: FACT_CHECK_HE,
  not_approved: 'המצגת כבר לא מאושרת, ולכן היא לא נשלחה.',
  hashtags: 'בכיתוב יש יותר מ-5 האשטגים. מורידים כמה בעריכה, ואז שולחים.',
  draft_in_flight: 'הטיוטה כבר בדרך לטיקטוק. עוד רגע זה ממשיך לבד.',
  no_consent: 'בחשבון הזה מצגות מגיעות לטיוטות בטיקטוק, ומשם מפרסמים אותן.',
  unconfirmed: 'לא הצלחנו לוודא אם המצגת עלתה בפעם הקודמת, ולכן לא שלחנו אותה שוב. בדקו בפרופיל, ואם היא לא שם, כתבו לנו.',
};

/** One failed send (a ZernioError, an InstagramError, a PublishRefused, a network error) in the customer's words. */
export function publishErrorHe(e, platform = null) {
  const name = nameOf(platform);
  const code = String(e?.code ?? '');
  const text = `${code} ${e?.category || ''} ${e?.message || ''}`;
  if (REFUSED_HE[code]) return REFUSED_HE[code];
  if (e?.name === 'PublishRefused' && ['shabbat', 'paused', 'image_review'].includes(code)) return e.message;
  if (code === 'not_configured') return 'הפרסום עוד לא זמין בשרת הזה. אנחנו מטפלים בזה.';
  if (code === 'no_account') return `${name} לא מחובר לחשבון. מחברים אותו בדף החשבון, והמצגת תעלה אחרי זה.`;
  if (code === 'card_images') return platform === 'instagram' ? 'באינסטגרם מצגת יכולה להכיל עד 10 תמונות, ובמצגת הזו יש יותר.' : 'בטיקטוק מצגת צריכה בין 2 ל-35 תמונות.';
  if (code === 'no_media_url') return 'השרת לא הצליח להעביר את התמונות לפלטפורמה. אנחנו מטפלים בזה.';
  if (e?.status === 401 || e?.status === 403 || /auth_expired|token|oauth|unauthori[sz]ed|reconnect/i.test(text) || [190, 102].includes(Number(code))) return `החיבור ל${name} הפסיק לעבוד. מחברים אותו מחדש בדף החשבון.`;
  if (/user_content|strike|violation|banned|suspend|restricted|spam/i.test(text) || Number(e?.subcode) === 2207051) return `${name} דחה את המצגת בגלל הכללים שלו. אפשר לראות אותה בדף המצגת.`;
  if (e?.status === 429 || /rate.?limit|too many|throttl/i.test(text) || [4, 17, 32, 613].includes(Number(code))) return `${name} ביקש לחכות קצת. ננסה שוב בעוד כמה דקות.`;
  if (/^(network|timeout)$/.test(code) || /timed out|ECONN|ENOTFOUND|fetch failed/i.test(text)) return `לא הצלחנו להגיע ל${name} הפעם. אפשר לנסות שוב מדף המצגת.`;
  return `המצגת לא עלתה ל${name}. שמרנו את הפרטים, ואפשר לנסות שוב מדף המצגת.`;
}

/**
 * Zernio's answer on the way back from a connect (error=, error_message=, is_user_fixable=) in the customer's words.
 * Zernio's own codes are matched by what they say, since they are not one fixed list; anything else gets the general
 * line, and the code itself stays in the audit log.
 */
export function connectErrorHe(platform, { error = '', message = '', fixable = false } = {}) {
  const name = nameOf(platform);
  const text = `${error} ${message}`;
  if (/denied|declined|cancel/i.test(text)) return `החיבור בוטל במסך של ${name}. צריך לאשר שם את כל ההרשאות, ואז זה עובד.`;
  // A permission first: Instagram's scopes are named instagram_business_*, which is not about the account's type.
  if (/permission|scope/i.test(text)) return `חסרה הרשאה במסך של ${name}. מנסים שוב ומאשרים את כל מה שמופיע שם.`;
  if (platform === 'instagram' && /business|professional|creator|personal|page/i.test(text)) return 'אינסטגרם מתחבר רק כחשבון מקצועי, עסקי או יוצר. מעבירים אותו לחשבון מקצועי בהגדרות של אינסטגרם ומנסים שוב.';
  if (/already|in.?use|exists|limit/i.test(text)) return `החשבון ב${name} כבר מחובר במקום אחר, או שהגענו למספר החשבונות שאפשר לחבר. כתבו לנו ונסדר את זה.`;
  if (/expired|state|timeout|session/i.test(text)) return 'עבר יותר מדי זמן מאז שהחיבור התחיל. מתחילים שוב, וזה לוקח דקה.';
  if (fixable) return `${name} לא אישר את החיבור. אפשר לנסות שוב, ובדרך כלל זה עובד בפעם השנייה.`;
  return `${name} לא אישר את החיבור הפעם. אפשר לנסות שוב, ואם זה חוזר, כתבו לנו ונבדוק.`;
}
