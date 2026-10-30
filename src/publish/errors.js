// What a customer reads when a post did not go out, or a connect did not take: Hebrew, short, and what to do next.
// The publisher's own words (Zernio's, Meta's) go to the log and the post's steps, never to the customer: they are
// English, they name codes, and they are written for us.

const NAME = { tiktok: 'טיקטוק', instagram: 'אינסטגרם', facebook: 'פייסבוק' };
const nameOf = (platform) => NAME[platform] || 'הפלטפורמה';

/** One failed send (a ZernioError, an InstagramError, a PublishRefused, a network error) in the customer's words. */
export function publishErrorHe(e, platform = null) {
  const name = nameOf(platform);
  const code = String(e?.code ?? '');
  const text = `${code} ${e?.category || ''} ${e?.message || ''}`;
  if (code === 'not_configured') return 'הפרסום עוד לא זמין בשרת הזה. אנחנו מטפלים בזה.';
  if (code === 'no_account') return `${name} לא מחובר לחשבון. מחברים אותו בדף החשבון, והמצגת תעלה אחרי זה.`;
  if (code === 'card_images') return platform === 'instagram' ? 'באינסטגרם מצגת יכולה להכיל עד 10 תמונות, ובמצגת הזו יש יותר.' : platform === 'facebook' ? 'בפוסט בפייסבוק אפשר עד 10 תמונות, ובמצגת הזו יש יותר.' : 'בטיקטוק מצגת צריכה בין 2 ל-35 תמונות.';
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
  // Zernio posts to a Page, never to a person's own profile.
  if (platform === 'facebook' && /page|personal|profile/i.test(text)) return 'פייסבוק מתחבר רק לעמוד שאתם מנהלים, לא לפרופיל אישי. אם עוד אין לעסק עמוד, פותחים אותו בפייסבוק ומחברים שוב.';
  if (/already|in.?use|exists|limit/i.test(text)) return `החשבון ב${name} כבר מחובר במקום אחר, או שהגענו למספר החשבונות שאפשר לחבר. כתבו לנו ונסדר את זה.`;
  if (/expired|state|timeout|session/i.test(text)) return 'עבר יותר מדי זמן מאז שהחיבור התחיל. מתחילים שוב, וזה לוקח דקה.';
  if (fixable) return `${name} לא אישר את החיבור. אפשר לנסות שוב, ובדרך כלל זה עובד בפעם השנייה.`;
  return `${name} לא אישר את החיבור הפעם. אפשר לנסות שוב, ואם זה חוזר, כתבו לנו ונבדוק.`;
}
