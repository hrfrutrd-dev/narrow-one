import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleRequest, rewriteText, upstreamFor } from '../src/worker.js';

const PROXY = 'https://example.workers.dev';
const request = (path, init) => new Request(PROXY + path, init);

function upstream(response, check = () => {}) {
  return async (req) => { await check(req); return response; };
}

test('the site and its config/maps route to fixed upstream hosts', () => {
  assert.equal(upstreamFor(new URL(PROXY + '/js/main.js?v=2')).href,
    'https://narrow.one/js/main.js?v=2');
  assert.equal(upstreamFor(new URL(PROXY + '/config/maps/a.glb?hash=abc')).href,
    'https://narrow-one.com/config/maps/a.glb?hash=abc');
  assert.equal(upstreamFor(new URL(PROXY + '/config/maps/a.nasset?hash=abc')).href,
    'https://narrow-one.com/config/maps/a.nasset?hash=abc');
  assert.equal(upstreamFor(new URL(PROXY + '/maps/old.glb')).href,
    'https://narrow.one/maps/old.glb');
  assert.equal(upstreamFor(new URL(PROXY + '/?url=https://evil.example')).href,
    'https://narrow.one/?url=https://evil.example');
  assert.equal(upstreamFor(new URL(PROXY + '//evil.example/path')).origin,
    'https://narrow.one');
  assert.equal(upstreamFor(new URL(PROXY + '/%2F%2Fevil.example/path')).origin,
    'https://narrow.one');
});

test('rewrites text assets without redirecting the separate game backend', async () => {
  const body = '<script src="https://narrow.one/js/index.js"></script>' +
    '<a href="https://narrow-one.com/config/maps/a.glb?hash=abc">map</a>' +
    '<a href="https://narrow-one.com/api/">backend</a>' +
    '<a href="https://matchmaking.narrow-one.com/">matchmaking</a>';
  const res = await handleRequest(request('/'), upstream(new Response(body, {
    headers: { 'content-type': 'text/html', 'content-length': '999', etag: 'old',
      'content-encoding': 'gzip', 'content-security-policy': "default-src 'self'",
      'x-frame-options': 'DENY' },
  }), (req) => assert.equal(req.url, 'https://narrow.one/')));
  const result = await res.text();
  assert.match(result, /https:\/\/example\.workers\.dev\/js\/index\.js/);
  assert.match(result, /https:\/\/example\.workers\.dev\/config\/maps\/a\.glb\?hash=abc/);
  assert.match(result, /https:\/\/narrow-one\.com\/api\//);
  assert.match(result, /https:\/\/matchmaking\.narrow-one\.com\//);
  for (const name of ['content-length', 'etag', 'content-encoding',
    'content-security-policy', 'x-frame-options']) assert.equal(res.headers.get(name), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(rewriteText('relative /config/maps/a.glb', PROXY),
    'relative /config/maps/a.glb');
  assert.equal(rewriteText('//narrow.one/js/main.js', PROXY), PROXY + '/js/main.js');
  assert.equal(rewriteText('https://narrow.one.evil.example/p', PROXY),
    'https://narrow.one.evil.example/p');
});

test('GLB and partial content are returned as binary without buffering or rewriting', async () => {
  const glb = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0, 255]);
  const res = await handleRequest(request('/config/maps/map.glb?hash=a', {
    headers: { range: 'bytes=0-5', cookie: 'private=1', authorization: 'Bearer secret' },
  }), upstream(new Response(glb, { status: 206, headers: {
    'content-type': 'model/gltf-binary', 'content-range': 'bytes 0-5/12345678',
    'accept-ranges': 'bytes', 'content-length': '6',
  } }), (req) => {
    assert.equal(req.url, 'https://narrow-one.com/config/maps/map.glb?hash=a');
    assert.equal(req.headers.get('range'), 'bytes=0-5');
    assert.equal(req.headers.get('cookie'), null);
    assert.equal(req.headers.get('authorization'), null);
  }));
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 0-5/12345678');
  assert.equal(res.headers.get('content-length'), '6');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), glb);
});

test('full GLB uses the upstream body stream unchanged', async () => {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
    controller.close();
  } });
  const res = await handleRequest(request('/config/maps/map.glb?hash=xyz'),
    upstream(new Response(body, { headers: {
      'content-type': 'model/gltf-binary', 'content-length': '4', etag: 'hash-xyz',
    } })));
  assert.equal(res.body, body);
  assert.equal(res.headers.get('etag'), 'hash-xyz');
  assert.equal(res.headers.get('content-length'), '4');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()),
    new Uint8Array([0x67, 0x6c, 0x54, 0x46]));
});

test('POST body and cookies reach the site, with origin translated', async () => {
  const res = await handleRequest(request('/api/auth/test', {
    method: 'POST', body: '{"login":true}',
    headers: { 'content-type': 'application/json', cookie: 'session=abc',
      origin: PROXY, referer: PROXY + '/', 'cf-connecting-ip': '1.2.3.4' },
  }), upstream(new Response('ok'), async (req) => {
    assert.equal(req.method, 'POST');
    assert.equal(await req.text(), '{"login":true}');
    assert.equal(req.headers.get('cookie'), 'session=abc');
    assert.equal(req.headers.get('origin'), 'https://narrow.one');
    assert.equal(req.headers.get('referer'), 'https://narrow.one/');
    assert.equal(req.headers.get('cf-connecting-ip'), null);
  }));
  assert.equal(await res.text(), 'ok');
});

test('redirects and Domain cookies remain on the proxy', async () => {
  const headers = new Headers({ location: 'https://narrow.one/auth/callback?x=1' });
  headers.append('set-cookie', 'session=a; Domain=.narrow.one; Path=/; Secure; HttpOnly');
  headers.append('set-cookie', 'other=b; Domain=narrow.one; Path=/');
  const res = await handleRequest(request('/login'), upstream(new Response(null, {
    status: 302, headers,
  })));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), PROXY + '/auth/callback?x=1');
  assert.deepEqual(res.headers.getSetCookie(), [
    'session=a; Path=/; Secure; HttpOnly', 'other=b; Path=/',
  ]);
  const cfg = await handleRequest(request('/config/next'), upstream(new Response(null, {
    status: 301, headers: { location: '/config/maps/next.glb' },
  })));
  assert.equal(cfg.headers.get('location'), PROXY + '/config/maps/next.glb');
});

test('upstream 101 WebSocket is passed through unmodified', async () => {
  const socketResponse = { status: 101, webSocket: {} };
  const res = await handleRequest(request('/socket', { headers: { upgrade: 'websocket' } }),
    upstream(socketResponse, (req) => {
      assert.equal(req.url, 'https://narrow.one/socket');
      assert.equal(req.headers.get('upgrade'), 'websocket');
    }));
  assert.equal(res, socketResponse);
});

test('HEAD has no body and upstream failures return 502', async () => {
  const res = await handleRequest(request('/config/maps/a.glb', { method: 'HEAD' }),
    upstream(new Response(null, { headers: { 'content-length': '2000' } })));
  assert.equal(res.body, null);
  assert.equal(res.headers.get('content-length'), '2000');
  const failure = await handleRequest(request('/'), async () => { throw new Error('offline'); });
  assert.equal(failure.status, 502);
});
