// Who a photograph search asks for, and whether a photograph shows them. Pure, with no imports, so the renderer can
// plan a slide on the right face (src/render/render.js planPhotos) and the build can check it (src/pipeline/build.js)
// without loading the photo libraries. src/images/index.js re-exports all of it.

/**
 * Whether a picture's title names the person a query names: two of the query's name
 * words side by side, as a name is written ("Holly_Holm_at_UFC"). A word of the name
 * was not enough ("Holm" matched "Rudder Rock, Steep Holm Island", "Serra" a plant
 * called Senecio serra), and neither were both words apart ("Holly with berries, Holm
 * Hill"). A query with a single name word needs that word.
 */
export function namesIn(title, names) {
  const words = String(title).toLowerCase().replace(/[_%]/g, ' ').split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
  const want = names.map((n) => n.toLowerCase());
  if (want.length < 2) return want.every((n) => words.includes(n));
  return want.slice(1).some((b, i) => words.some((w, j) => w === want[i] && words[j + 1] === b));
}

/** The names a query asks a picture to show: its capitalised words, less the promotions' and the sport's own. */
export const namesOf = (query) => String(query).split(/\s+/).filter((w) => /^\p{Lu}\p{L}{2,}/u.test(w) && !/^(UFC|PFL|ONE|MMA|BJJ|FC|The|Stadium|Arena|Park)$/i.test(w));

// The words of a query that name no one: a competition, an award, an event, a sport or a season. "Champions League
// trophy" is a thing; "Sadio Mane" and "Fenerbahce" are someone.
const NO_ONE = new Set(['league', 'liga', 'ligue', 'serie', 'bundesliga', 'eredivisie', 'premier', 'champions', 'europa', 'conference', 'libertadores', 'cup', 'copa', 'coupe', 'pokal', 'world', 'euro', 'euros', 'olympics', 'olympic', 'paralympics', 'games', 'final', 'finals', 'trophy', 'championship', 'championships', 'tournament', 'grand', 'prix', 'formula', 'open', 'masters', 'series', 'tour', 'award', 'awards', 'ballon', 'season', 'derby', 'super', 'bowl', 'fight', 'night', 'day', 'week', 'nba', 'nfl', 'nhl', 'mlb', 'fifa', 'uefa', 'var', 'football', 'soccer', 'basketball', 'boxing', 'tennis', 'golf', 'rugby', 'cricket', 'hockey', 'baseball']);
// A kind of place: the capitalised words just before it are the place's name ("Wembley Stadium", "Camp Nou stadium"),
// not someone's.
const PLACE_WORD = /^(?:stadium|arena|park|ground|field|pitch|hall|square|street|beach|bridge|tower|museum|airport|station|market|mountain|river|lake|island|palace|church|temple|castle|court|track|circuit|gym|clubhouse)$/i;

const letters = (w) => w.toLowerCase().replace(/[^\p{L}]/gu, '');

// The name words of a query in runs, as they are written: "Revivo goal Spain 1998" is [[Revivo], [Spain]], "Sadio
// Mane Liverpool" one run of three.
function nameRuns(query) {
  const words = String(query || '').split(/\s+/).filter(Boolean);
  const place = new Set();
  words.forEach((w, i) => {
    if (!PLACE_WORD.test(letters(w))) return;
    for (let k = i - 1; k >= 0 && /^\p{Lu}/u.test(words[k]); k--) place.add(k);
  });
  const runs = [];
  let run = null;
  words.forEach((w, i) => {
    if (place.has(i) || !namesOf(w).length || NO_ONE.has(letters(w))) {
      run = null;
      return;
    }
    if (!run) runs.push((run = []));
    run.push(w);
  });
  return runs;
}

/**
 * The person or club a query asks a photograph to show, as its name words, or []: its capitalised words (namesOf), less
 * a competition's, an event's or a place's ("Champions League trophy", "Wembley Stadium" and "football stadium night"
 * name no one; "Sadio Mane" and "Fenerbahce" do). A slide whose imageQuery names someone is about them, and stands on a
 * photograph of them (the owner, 2026-10-31: "names cant be written without an image that connects them visually. i
 * did not understand who מאנה is first").
 */
export const whoIn = (query) => nameRuns(query).flat();

const wordsOf = (t) => String(t || '').toLowerCase().replace(/[_%]/g, ' ').split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);

/**
 * Does this photograph show whom a slide's query (its imageQuery) names? Its own search, its file's title or its
 * description names them as a name is written (namesIn), or its own search or title has the surname of the first one
 * the query names ("Revivo goal Spain 1998": Revivo; "Sadio Mane Liverpool": Mane), as when a cover's photograph was
 * found for the post's subject by name. A first name alone is not enough: Lionel Scaloni is not Lionel Messi. A
 * photograph shows anyone when the query names no one.
 */
export function shows(img, query) {
  const names = whoIn(query);
  if (!img || !names.length) return Boolean(img);
  if ([img.query, img.provider_id, img.alt].some((t) => namesIn(String(t || ''), names))) return true;
  const [first] = nameRuns(query);
  const surname = (first.length > 1 ? first[1] : first[0]).toLowerCase();
  return [img.query, img.provider_id].some((t) => wordsOf(t).includes(surname));
}
