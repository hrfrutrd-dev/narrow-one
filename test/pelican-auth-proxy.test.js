import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleRequest } from '../src/worker.js';

const origin = 'https://example.workers.dev';
const site = origin + '/__pelican/site';
const api = origin + '/__pelican/api';
const noFetch = () => { throw new Error('must not fetch'); };

test('forwards only prefixed Pelican cookies and isolates new cookies', async () => {
  const res = await handleRequest(new Request(site + '/login', { headers: { cookie: 'game=secret; n1peli_session=abc; n1peli___Host-test=xyz' } }), async req => {
    assert.equal(req.url, 'https://pelicanparty.games/login');
    assert.equal(req.headers.get('cookie'), 'session=abc; __Host-test=xyz');
    assert.equal(req.redirect, 'manual');
    const h = new Headers({ 'content-type': 'text/html' });
    h.append('set-cookie', '__Host-session=token; Path=/; Secure; HttpOnly; SameSite=Lax');
    h.append('set-cookie', 'other=1; Domain=.pelicanparty.games; Path=/login; Secure');
    return new Response('<html><body><form action="/login"><script src="/static/a.js"></script></form></body></html>', { headers: h });
  });
  assert.deepEqual(res.headers.getSetCookie(), [
    'n1peli___Host-session=token; Path=/__pelican/site/; Secure; HttpOnly; SameSite=Lax',
    'n1peli_other=1; Path=/__pelican/site/login; Secure',
  ]);
  const html = await res.text();
  assert.match(html, /メールアドレスと確認コード/);
  assert.match(html, /action="https:\/\/example\.workers\.dev\/__pelican\/site\/login"/);
  assert.match(html, /src="https:\/\/example\.workers\.dev\/__pelican\/site\/static\/a\.js"/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('redirects and JSON navigation stay on the fixed Pelican site', async () => {
  const res = await handleRequest(new Request(site + '/auth/popup'), async () => new Response(null, {
    status: 302, headers: { location: '/login?redirect=authPopup' },
  }));
  assert.equal(res.headers.get('location'), site + '/login?redirect=authPopup');
  const json = await handleRequest(new Request(site + '/login/verifyEmailToken', {
    method: 'POST', headers: { origin }, body: 'verificationToken=secret',
  }), async req => {
    assert.equal(req.url, 'https://pelicanparty.games/login/verifyEmailToken');
    assert.equal(req.headers.get('origin'), 'https://pelicanparty.games');
    assert.equal(await req.text(), 'verificationToken=secret');
    return Response.json({ url: '/auth/popup?state=abc' });
  });
  assert.equal((await json.json()).url, site + '/auth/popup?state=abc');
  const bad = await handleRequest(new Request(site + '/auth/popup'), async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
  assert.equal(bad.status, 502);
});

test('cross-origin writes, unsafe paths and oversized requests are rejected', async () => {
  assert.equal((await handleRequest(new Request(site + '/login', { method: 'POST', headers: { origin: 'https://evil.example' }, body: 'email=x' }), noFetch)).status, 403);
  assert.equal((await handleRequest(new Request(site + '/login', { method: 'POST', body: 'email=x' }), noFetch)).status, 403);
  assert.equal((await handleRequest(new Request(site + '/other', { method: 'POST', headers: { origin }, body: 'x' }), noFetch)).status, 404);
  assert.equal((await handleRequest(new Request(site + '/login', { method: 'POST', headers: { origin }, body: 'x'.repeat(131073) }), noFetch)).status, 413);
  assert.equal((await handleRequest(new Request(api + '/v1/unknown'), noFetch)).status, 404);
});

test('only intended API calls forward authorization, never game cookies', async () => {
  const response = await handleRequest(new Request(api + '/v1/auth/createServerCode', {
    method: 'POST', headers: { origin, authorization: 'Bearer secret', cookie: 'game=secret', 'content-type': 'application/json' }, body: '{}',
  }), async req => {
    assert.equal(req.url, 'https://api.pelicanparty.games/v1/auth/createServerCode');
    assert.equal(req.headers.get('authorization'), 'Bearer secret');
    assert.equal(req.headers.get('cookie'), null);
    assert.equal(req.headers.get('origin'), 'https://api.pelicanparty.games');
    return Response.json({ code: 'secret' });
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).code, 'secret');
});
