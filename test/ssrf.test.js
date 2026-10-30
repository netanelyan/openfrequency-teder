import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { __testNet, blockedAddress, doorFetch, getText, NetError } from '../src/core/net.js';
import { selfSigned } from './tls.js';

// The open web is the public internet, on every hop: a source that is this machine, a private network or a cloud's
// metadata service, by its own address, by a name that resolves to one, or by a redirect onto one, is refused before
// a byte is sent, and the connection goes to the address that was checked, never to a second DNS answer.
//
// Three servers on this machine: a redirector (let through by name, as a source on the internet would be) that answers
// 302 to wherever it is told, and two targets, https and http, that count what reaches them. Nothing may.

let redirector;
let target;
let plain;
let hits = 0;
let restore;
const lookups = [];
// The test's DNS: names that point at this machine, one that mixes a public address with it, one that answers
// differently the second time it is asked.
const DNS = {
  'redirector.test': [{ address: '127.0.0.1', family: 4 }],
  'evil.test': [{ address: '127.0.0.1', family: 4 }],
  'localhost': [{ address: '127.0.0.1', family: 4 }],
  'meta.test': [{ address: '169.254.169.254', family: 4 }],
  'inside.test': [{ address: '10.1.2.3', family: 4 }],
  'v6.test': [{ address: '::1', family: 6 }],
  'mixed.test': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
};
let pinAsked = 0;

before(async () => {
  const tls = selfSigned({ names: ['redirector.test', 'pin.test', 'evil.test', 'localhost'], ips: ['127.0.0.1'] });
  redirector = httpsServer(tls, (req, res) => {
    const to = new URL(req.url, 'https://x').searchParams.get('u');
    if (to) {
      res.writeHead(302, { location: to });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('fine');
  });
  target = httpsServer(tls, (req, res) => {
    hits++;
    res.end('secret');
  });
  plain = httpServer((req, res) => {
    hits++;
    res.end('secret');
  });
  for (const s of [redirector, target, plain]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
  restore = __testNet({
    lookup: async (host) => {
      lookups.push(host);
      if (host === 'pin.test') {
        // The first answer is this machine (let through, as the redirector is); a second would be a private network.
        // The connection must use the first.
        pinAsked++;
        return pinAsked === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.255.255.1', family: 4 }];
      }
      if (DNS[host]) return DNS[host];
      throw Object.assign(new Error('no such name'), { code: 'ENOTFOUND' });
    },
    exempt: (host) => host === 'redirector.test' || host === 'pin.test',
    tls: { rejectUnauthorized: false },
  });
});

after(async () => {
  restore?.();
  for (const s of [redirector, target, plain]) await new Promise((r) => (s ? s.close(r) : r()));
});

const tp = () => target.address().port;
const pp = () => plain.address().port;
const via = (url) => `https://redirector.test:${redirector.address().port}/go?u=${encodeURIComponent(url)}`;

/** Every way of writing an address that is not on the public internet, as a source could give it. */
const hostile = () => [
  [`https://127.0.0.1:${tp()}/`, 'private_address'],
  [`https://localhost:${tp()}/`, 'private_address'],
  [`https://evil.test:${tp()}/`, 'private_address'],
  [`https://2130706433:${tp()}/`, 'private_address'],
  [`https://0x7f000001:${tp()}/`, 'private_address'],
  [`https://0177.0.0.1:${tp()}/`, 'private_address'],
  [`https://127.1:${tp()}/`, 'private_address'],
  [`https://[::1]:${tp()}/`, 'private_address'],
  [`https://[::ffff:127.0.0.1]:${tp()}/`, 'private_address'],
  [`https://[::ffff:7f00:1]:${tp()}/`, 'private_address'],
  [`https://[::7f00:1]:${tp()}/`, 'private_address'],
  [`https://mixed.test:${tp()}/`, 'private_address'],
  [`https://v6.test:${tp()}/`, 'private_address'],
  ['https://10.0.0.1/', 'private_address'],
  ['https://inside.test/', 'private_address'],
  ['https://172.16.0.1/', 'private_address'],
  ['https://192.168.1.1/', 'private_address'],
  ['https://169.254.169.254/latest/meta-data/', 'private_address'],
  ['https://meta.test/latest/meta-data/', 'private_address'],
  ['https://100.64.0.1/', 'private_address'],
  ['https://0.0.0.0/', 'private_address'],
  ['https://[::]/', 'private_address'],
  ['https://[fc00::1]/', 'private_address'],
  ['https://[fd12:3456::1]/', 'private_address'],
  ['https://[fe80::1]/', 'private_address'],
  ['https://[64:ff9b::7f00:1]/', 'private_address'],
  [`http://127.0.0.1:${pp()}/`, 'refused'],
  [`http://example.org:${pp()}/`, 'refused'],
];

async function refusal(url) {
  try {
    await getText(url, { timeoutMs: 5000 });
  } catch (e) {
    return e;
  }
  return null;
}

test('the address check: this machine, private networks, link-local, CGNAT, unique-local and unspecified are not public', () => {
  for (const a of ['127.0.0.1', '10.0.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::7f00:1', '224.0.0.1']) {
    assert.ok(blockedAddress(a), `${a} is refused`);
  }
  for (const a of ['93.184.216.34', '8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5', '::ffff:8.8.8.8', '172.32.0.1', '100.128.0.1']) assert.equal(blockedAddress(a), null, `${a} is public`);
});

test('every hostile address is refused with a typed error, asked for directly, and nothing reaches the target', async () => {
  hits = 0;
  for (const [url, code] of hostile()) {
    const e = await refusal(url);
    assert.ok(e instanceof NetError, `${url}: ${e?.message || 'it was fetched'}`);
    assert.equal(e.code, code, `${url}: ${e.message}`);
  }
  assert.equal(hits, 0, 'no request reached a target');
});

test('a redirect onto every hostile address is refused at the hop, and nothing reaches the target', async () => {
  // The redirector itself answers: it is the hop after it that is refused.
  assert.equal((await getText(`https://redirector.test:${redirector.address().port}/`)).body, 'fine');
  hits = 0;
  for (const [url, code] of hostile()) {
    const e = await refusal(via(url));
    assert.ok(e instanceof NetError, `${url} through a redirect: ${e?.message || 'it was fetched'}`);
    assert.equal(e.code, code, `${url} through a redirect: ${e.message}`);
  }
  assert.equal(hits, 0, 'no request reached a target');
});

test('the connection goes to the address that was checked: a second, different DNS answer is never asked for', async () => {
  pinAsked = 0;
  const res = await doorFetch(`https://pin.test:${tp()}/`, { timeoutMs: 5000 });
  assert.equal(await res.text(), 'secret');
  assert.equal(pinAsked, 1, 'the name was resolved once, by the check, and the connection used that answer');
});

test('a name that does not resolve is a network error, never a request', async () => {
  const e = await refusal('https://nowhere.test/');
  assert.equal(e?.code, 'network');
});
