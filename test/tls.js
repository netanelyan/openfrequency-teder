import { generateKeyPairSync, sign } from 'node:crypto';

// A throwaway TLS certificate for a test server on this machine, made at run time: a key in the repository would be
// a key in the repository (scripts/check-public.js refuses one), and openssl is not on every machine that runs the
// tests. A P-256 key and a self-signed X.509 v3 certificate, written out in DER by hand: the few fields a TLS server
// needs, and the names it answers to.

const len = (n) => {
  if (n < 128) return Buffer.from([n]);
  const b = [];
  for (let m = n; m; m >>= 8) b.unshift(m & 255);
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const oid = (s) => {
  const a = s.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const n of a.slice(2)) {
    const b = [n & 127];
    for (let m = n >> 7; m; m >>= 7) b.unshift((m & 127) | 128);
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
};
const utc = (d) => tlv(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));

/** { key, cert } in PEM, for these DNS names and IPv4 addresses, good from yesterday for a year. */
export function selfSigned({ names = ['localhost'], ips = ['127.0.0.1'] } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const alg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from('teder test')))));
  const san = seq(...names.map((n) => tlv(0x82, Buffer.from(n))), ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))));
  const from = new Date(Date.now() - 86_400_000);
  const to = new Date(Date.now() + 365 * 86_400_000);
  const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([1])), alg, name, seq(utc(from), utc(to)), name, publicKey.export({ type: 'spki', format: 'der' }), tlv(0xa3, seq(seq(oid('2.5.29.17'), tlv(0x04, san)))));
  const der = seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert };
}
