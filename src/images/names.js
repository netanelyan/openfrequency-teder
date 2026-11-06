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
  // A name's joining words ("Shrine of the Book", "Leonardo da Vinci") and its apostrophes ("Murabba'at", filed as
  // "Murabbaat") do not tell two names apart: a query's names never hold them (namesOf), so a title's are left out
  // too, or "Shrine Book" never met "Shrine_of_the_Book.jpg" (75 photographs passed over, 2026-11-06).
  const bare = (w) => w.replace(/['’`]/g, '');
  const words = String(title).toLowerCase().replace(/[_%]/g, ' ').split(/[^\p{L}\p{N}'’`-]+/u).filter((w) => w && !JOIN.has(w)).map(bare);
  const want = names.map((n) => bare(n.toLowerCase()));
  if (want.length < 2) return want.every((n) => words.includes(n));
  return want.slice(1).some((b, i) => words.some((w, j) => w === want[i] && words[j + 1] === b));
}

/** The small words inside a name: "Shrine of the Book", "Leonardo da Vinci", "Simeon bar Yochai". */
const JOIN = new Set(['of', 'the', 'de', 'del', 'della', 'da', 'di', 'du', 'la', 'le', 'al', 'el', 'ha', 'bin', 'ibn', 'ben', 'bar', 'von', 'van', 'der', 'den']);

/** The names a query asks a picture to show: its capitalised words, less the promotions' and the sport's own. */
export const namesOf = (query) => String(query).split(/\s+/).filter((w) => /^\p{Lu}\p{L}{2,}/u.test(w) && !/^(UFC|PFL|ONE|MMA|BJJ|FC|The|Stadium|Arena|Park)$/i.test(w));

// The words of a query that name no one: a competition, an award, an event, a sport or a season. "Champions League
// trophy" is a thing; "Sadio Mane" and "Fenerbahce" are someone.
const NO_ONE = new Set(['league', 'liga', 'ligue', 'serie', 'bundesliga', 'eredivisie', 'premier', 'champions', 'europa', 'conference', 'libertadores', 'cup', 'copa', 'coupe', 'pokal', 'world', 'euro', 'euros', 'olympics', 'olympic', 'paralympics', 'games', 'final', 'finals', 'trophy', 'championship', 'championships', 'tournament', 'grand', 'prix', 'formula', 'open', 'masters', 'series', 'tour', 'award', 'awards', 'ballon', 'season', 'derby', 'super', 'bowl', 'fight', 'night', 'day', 'week', 'nba', 'nfl', 'nhl', 'mlb', 'fifa', 'uefa', 'var', 'football', 'soccer', 'basketball', 'boxing', 'tennis', 'golf', 'rugby', 'cricket', 'hockey', 'baseball']);
// A kind of place: the capitalised words just before it are the place's name ("Wembley Stadium", "Camp Nou stadium"),
// not someone's.
const PLACE_WORD = /^(?:stadium|arena|park|ground|field|pitch|hall|square|street|beach|bridge|tower|museum|airport|station|market|mountain|mountains|river|lake|island|palace|church|temple|castle|court|track|circuit|gym|clubhouse|wadi|nahal|mount|cave|caves|desert|valley|canyon|crater|forest|reserve|sea|bay|gulf|cape|coast|falls|spring|springs|shrine|tomb|monastery|synagogue|cathedral|mosque|fortress|fort|tel|ein|har|trail)$/i;
// A kind of place written before its name ("Wadi Murabba'at", "Mount Hermon", "Shrine of the Book"): the capitalised
// words after it are the place's too. A slide that names a place does not name someone: the camping account's first
// sample (2026-11-06) was blocked for having no photograph of "Wadi Murabba'at" and of "Shrine Book".
const PLACE_FIRST = /^(?:wadi|nahal|mount|lake|river|cape|fort|tel|ein|har|gulf|bay|sea|shrine|tomb|temple|church|cathedral|monastery|palace|castle|museum|valley|desert|cave|caves)$/i;

const letters = (w) => w.toLowerCase().replace(/[^\p{L}]/gu, '');

// The name words of a query in runs, as they are written: "Revivo goal Spain 1998" is [[Revivo], [Spain]], "Sadio
// Mane Liverpool" one run of three.
function nameRuns(query) {
  const words = String(query || '').split(/\s+/).filter(Boolean);
  const place = new Set();
  const inName = (k) => /^\p{Lu}/u.test(words[k]) || JOIN.has(words[k].toLowerCase());
  words.forEach((w, i) => {
    if (!PLACE_WORD.test(letters(w))) return;
    place.add(i);
    for (let k = i - 1; k >= 0 && /^\p{Lu}/u.test(words[k]); k--) place.add(k);
    if (PLACE_FIRST.test(letters(w))) for (let k = i + 1; k < words.length && inName(k); k++) place.add(k);
  });
  const runs = [];
  let run = null;
  words.forEach((w, i) => {
    // A joining word between two name words keeps them one name ("Leonardo da Vinci"), and is not a name word itself.
    if (run && JOIN.has(w.toLowerCase()) && i + 1 < words.length && namesOf(words[i + 1]).length && !place.has(i + 1)) return;
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
