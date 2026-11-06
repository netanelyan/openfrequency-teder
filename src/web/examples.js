import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The examples beside each kind of slideshow and each slide style on Teder's pickers (the owner, 2026-11-06: "the teder
// website should show an example of the format, not only a description"): one slide of each, drawn by the engine from
// the demo pack's recordings by scripts/render-examples.js and served as static files (src/web/static/examples). Never
// drawn when a page is asked for, and never with a key.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static', 'examples');

/** A file's name the route serves: a format's or a style's example, nothing else. */
export const EXAMPLE_FILE = /^(?:format-[a-z0-9-]+|style-[A-E])\.jpg$/;

/** The address of an example, or null when none was drawn: `format-<id>` or `style-<letter>`. */
export function exampleSrc(name) {
  const file = `${name}.jpg`;
  return EXAMPLE_FILE.test(file) && existsSync(path.join(DIR, file)) ? `/static/examples/${file}` : null;
}

/** The example as a small, lazy picture with its alt text, or ''. */
export function exampleImg(name, alt, { esc, cls = 'ex' }) {
  const src = exampleSrc(name);
  return src ? `<img class="${cls}" src="${src}" alt="${esc(alt)}" loading="lazy" decoding="async" width="90" height="160">` : '';
}

export const EXAMPLES_DIR = DIR;
