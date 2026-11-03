// What a stored photograph is, read from its own bytes: its size, and whether it has see-through parts.
//
// A cover photograph smaller than FULL_BLEED_MIN on its shorter side is not stretched over the whole slide: it is
// drawn in a frame over a blurred copy of itself (src/render/html.js). And a PNG with transparency (a fighter cut
// out of the photograph's background) is flattened onto a solid ground (flatten, in safety.js) before the screen
// looks at it and before it is stored, so no slide shows through a see-through photograph.

export const FULL_BLEED_MIN = 1000;

/** { type: 'png'|'jpeg', width, height, alpha } from a PNG's or a JPEG's header, or null. Pure. */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) {
    // IHDR: width, height, bit depth, colour type (4 grey + alpha, 6 RGB + alpha); a tRNS chunk makes any type see-through.
    const colourType = buf[25];
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), alpha: colourType === 4 || colourType === 6 || buf.includes(Buffer.from('tRNS')) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      // The frame header (SOF0 to SOF15, but not DHT, JPG or DAC) holds the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), alpha: false };
      i += 2 + len;
    }
  }
  return null;
}

/** A picture's kind from its first bytes: 'png', 'jpg', 'webp', or null. */
export const imageExt = (buf) => {
  const b = Buffer.from(buf || []);
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
};

/** { type: 'webp', width, height } from a WebP's first chunk (VP8, VP8L or VP8X), or null. Pure. */
export function webpSize(buf) {
  if (!buf || buf.length < 30 || imageExt(buf) !== 'webp') return null;
  const chunk = buf.toString('latin1', 12, 16);
  // Lossy: the key frame's start code, then 14 bits of width and of height.
  if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  // Lossless: its signature, then 14 bits each of width and height less one.
  if (chunk === 'VP8L' && buf[20] === 0x2f) {
    const bits = buf.readUInt32LE(21);
    return { type: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  // Extended: the canvas, 24 bits each less one.
  if (chunk === 'VP8X') return { type: 'webp', width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  return null;
}

/** Whether a cover photograph fills the slide, or is framed over its own blurred copy. */
export const fillsCover = (buf) => {
  const s = imageSize(buf);
  return !s || Math.min(s.width, s.height) >= FULL_BLEED_MIN;
};
