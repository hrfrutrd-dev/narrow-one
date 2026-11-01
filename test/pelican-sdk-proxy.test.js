import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleRequest } from '../src/worker.js';
import { patchPelicanSdkImport } from '../src/pelican-sdk-proxy.js';

const origin = 'https://example.workers.dev';
const path = '/__narrow_peli_sdk/';
const fixture = 'async function f(){let s="https://js.pelicanparty.games/v1.js";const n=await import(s),{init:o}=n;return o()}';

test('game tries the official SDK first and falls back only on import failure', async () => {
  const patched = patchPelicanSdkImport(fixture);
  assert.match(patched, /try\{n=await import\(s\)\}catch\{n=await import\("\/__narrow_peli_sdk\/v1.js"\)\}/);
  assert.equal(patchPelicanSdkImport(fixture + fixture), fixture + fixture);
  assert.equal(patchPelicanSdkImport('const n=await import(s),{init:o}=n;'), 'const n=await import(s),{init:o}=n;');
  const res = await handleRequest(new Request(origin + '/js/index-test.js'), async () => new Response(fixture, { headers: { 'content-type': 'application/javascript' } }));
  assert.equal(await res.text(), patched);
});

test('public SDK module is fetched only from fixed upstream with no credentials', async () => {
  const res = await handleRequest(new Request(origin + path + 'browserSdk/abc.js?v=1', { headers: {
    cookie: 'secret=1', authorization: 'Bearer secret', origin,
  } }), async req => {
    assert.equal(req.url, 'https://js.pelicanparty.games/browserSdk/abc.js?v=1');
    assert.equal(req.headers.get('cookie'), null);
    assert.equal(req.headers.get('authorization'), null);
    assert.equal(req.headers.get('origin'), null);
    assert.equal(req.redirect, 'manual');
    return new Response('const base = new URL(import.meta.url); export {base};', { headers: {
      'content-type': 'text/javascript', 'set-cookie': 'secret=1',
    } });
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(await res.text(), /new URL\("https:\/\/js\.pelicanparty\.games\/browserSdk\/abc\.js\?v=1"\)/);
});

test('relative SDK module imports remain rooted at the SDK proxy path', async () => {
  const res = await handleRequest(new Request(origin + path + 'v1.js'), async req => {
    assert.equal(req.url, 'https://js.pelicanparty.games/v1.js');
    return new Response('export * from "./browserSdk/abc.js?v=1"', { headers: { 'content-type': 'application/javascript' } });
  });
  assert.equal(await res.text(), 'export * from "./browserSdk/abc.js?v=1"');
  assert.equal(new URL('./browserSdk/abc.js?v=1', origin + path + 'v1.js').href,
    origin + path + 'browserSdk/abc.js?v=1');
});

test('rejects arbitrary paths, methods, redirects and non-JavaScript responses', async () => {
  for (const pathname of ['login', 'browserSdk/x.js/extra', 'browserSdk/%2e%2e', 'https://evil.example/', 'v1.js/extra']) {
    const response = await handleRequest(new Request(origin + path + pathname), () => { throw new Error('must not fetch'); });
    assert.equal(response.status, 404);
  }
  const badMethod = await handleRequest(new Request(origin + path + 'v1.js', { method: 'POST', body: 'sensitive' }), () => { throw new Error('must not fetch'); });
  assert.equal(badMethod.status, 405);
  const redirect = await handleRequest(new Request(origin + path + 'v1.js'), async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }));
  assert.equal(redirect.status, 502);
  const html = await handleRequest(new Request(origin + path + 'v1.js'), async () => new Response('<h1>Error</h1>', { headers: { 'content-type': 'text/html' } }));
  assert.equal(html.status, 502);
});
