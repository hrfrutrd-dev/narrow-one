import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installLoginAssist } from '../src/login-assist.js';
import { handleRequest } from '../src/worker.js';

const origin = 'https://example.workers.dev';
const issuer = 'https://accounts.google.com';

function browser(fetch) {
  const nodes = new Map();
  const doc = {
    getElementById: (id) => nodes.get(id),
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {},
      append(...children) { for (const child of children) if (child.id) nodes.set(child.id, child); },
      remove() {} }),
    body: { appendChild(node) { nodes.set(node.id, node); } },
  };
  const win = { fetch, document: doc, addEventListener() {}, location: { href: origin + '/', origin } };
  installLoginAssist(win);
  return { win, nodes };
}

test('public issuer lookup is restricted to configured providers and strips credentials', async () => {
  const url = origin + '/__narrow_login/issuer?issuer=' + encodeURIComponent(issuer);
  const response = await handleRequest(new Request(url, { headers: { cookie: 'secret=1', authorization: 'Bearer secret' } }), async (req) => {
    assert.equal(req.url, 'https://narrow-one.com/api/auth/getIssuerConfig?issuer=https%3A%2F%2Faccounts.google.com');
    assert.equal(req.headers.get('cookie'), null);
    assert.equal(req.headers.get('authorization'), null);
    assert.equal(req.redirect, 'manual');
    return new Response('{"clientId":"public"}', { headers: { 'set-cookie': 'session=secret' } });
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  for (const query of ['issuer=https://evil.example', 'issuer=https://discord.com&extra=1',
    'issuer=https://discord.com&issuer=https://discord.com']) {
    const res = await handleRequest(new Request(origin + '/__narrow_login/issuer?' + query), () => { throw Error('must not fetch'); });
    assert.equal(res.status, 400);
  }
  assert.equal((await handleRequest(new Request(url, { method: 'POST' }))).status, 405);
  assert.equal((await handleRequest(new Request(url), async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }))).status, 502);
});

test('injects assist only into game HTML and serves the script locally', async () => {
  const html = '<html><head><script type="module" src="js/index-CGd_1Yik.js"></script></head></html>';
  const res = await handleRequest(new Request(origin + '/'), async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
  assert.match(await res.text(), /<head><script src="\/__narrow_login\/assist.js"><\/script><script type="module"/);
  const script = await handleRequest(new Request(origin + '/__narrow_login/assist.js'), () => { throw Error('must not fetch'); });
  assert.match(await script.text(), /installLoginAssist/);
  const other = await handleRequest(new Request(origin + '/other'), async () => new Response('<head>other</head>', { headers: { 'content-type': 'text/html' } }));
  assert.equal(await other.text(), '<head>other</head>');
});

test('retries only failed public config GET, never provider URLs or session POSTs', async () => {
  const calls = [];
  const { win, nodes } = browser(async (url, init) => {
    calls.push([String(url), init]);
    if (String(url).includes('/__narrow_login/issuer')) return new Response('{}');
    throw new TypeError('network failed');
  });
  const url = 'https://narrow-one.com/api/auth/getIssuerConfig?issuer=' + encodeURIComponent(issuer);
  assert.equal((await win.fetch(url)).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], origin + '/__narrow_login/issuer?issuer=' + encodeURIComponent(issuer));
  assert.equal(calls[1][1].credentials, 'omit');
  await assert.rejects(win.fetch('https://narrow-one.com/api/auth/getSession', { method: 'POST', body: 'token=secret' }));
  assert.equal(calls.length, 3);
  assert.match(nodes.get('narrow-login-assist-text').textContent, /セッション/);
  await assert.rejects(win.fetch('https://accounts.google.com/o/oauth2/v2/auth'));
  assert.equal(calls.length, 4);
});

test('aborted config request is not retried or reported as an error', async () => {
  let count = 0;
  const { win, nodes } = browser(async () => { count++; throw new DOMException('aborted', 'AbortError'); });
  await assert.rejects(win.fetch('https://narrow-one.com/api/auth/getIssuerConfig?issuer=' + encodeURIComponent(issuer)));
  assert.equal(count, 1);
  assert.equal(nodes.size, 0);
});

test('upstream error status is reported without disclosing response contents', async () => {
  const { win, nodes } = browser(async () => new Response('sensitive body', { status: 403 }));
  assert.equal((await win.fetch('https://narrow-one.com/api/auth/getSession', { method: 'POST' })).status, 403);
  const message = nodes.get('narrow-login-assist-text').textContent;
  assert.match(message, /HTTP 403/);
  assert.doesNotMatch(message, /sensitive/);
});
