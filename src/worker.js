import { LOGIN_ASSIST_SCRIPT } from './login-assist.js';
import { patchPelicanSdkImport, proxyPelicanSdk } from './pelican-sdk-proxy.js';

// A same-origin reverse proxy for the Narrow One client. Do not accept an
// arbitrary destination URL: that would turn this Worker into an open proxy.
const SITE = new URL('https://narrow.one');
const ASSETS = new URL('https://narrow-one.com');
const TEXT_TYPES = /^(?:text\/html|text\/css|(?:text|application)\/(?:javascript|x-javascript))\b/i;
const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
];

export function upstreamFor(url) {
  // Current map/config data (including multi-MB GLB and .nasset files) lives
  // on narrow-one.com, not narrow.one. Leave the path and hash query intact.
  const origin = url.pathname.startsWith('/config/') ? ASSETS : SITE;
  // Assign path/search separately: new URL('//evil.example', SITE) would
  // otherwise interpret a user-supplied double-slash path as a new host.
  const target = new URL(origin);
  target.pathname = url.pathname;
  target.search = url.search;
  return target;
}

export function rewriteUrl(value, proxyOrigin) {
  // Repoint links to the site, while leaving third-party endpoints (including
  // narrow-one.com and matchmaking.narrow-one.com) untouched.
  let parsed;
  try { parsed = new URL(value, SITE); } catch { return value; }
  if (parsed.origin === SITE.origin) {
    return proxyOrigin + parsed.pathname + parsed.search + parsed.hash;
  }
  if (parsed.origin === ASSETS.origin && parsed.pathname.startsWith('/config/')) {
    return proxyOrigin + parsed.pathname + parsed.search + parsed.hash;
  }
  return value;
}

// The 2026-10-31 game bundle creates the login dialog before the asynchronous
// Pelican SDK has necessarily initialized. Patch only the exact observed code;
// if an upstream update changes it, leave that bundle untouched.
export function waitForPelicanSdk(text) {
  const before = 'async showLoginDialog(t="login"){const e=new jn(this.gameWrapper,t);po().dialogManager.addDialog(e);';
  if (!text.includes('class $n{') || !text.includes('getPeliSdkAsync()') ||
      text.indexOf(before) === -1 || text.indexOf(before) !== text.lastIndexOf(before)) return text;
  const after = 'async showLoginDialog(t="login"){await Promise.race([po().getPeliSdkAsync(),new Promise(t=>setTimeout(t,5000))]);if(!po().getPeliSdk())window.dispatchEvent(new Event("narrow-peli-sdk-unavailable"));const e=new jn(this.gameWrapper,t);po().dialogManager.addDialog(e);';
  return text.replace(before, after);
}

// Match complete literal URLs, including third-party URLs, before deciding
// whether to rewrite them. Otherwise a narrow.one URL embedded unescaped in
// an OAuth provider's query string could be mistaken for a standalone URL:
// registered redirect_uri values must not be changed by this proxy.
// Relative paths already resolve against the Worker; leave binaries alone.
export function rewriteText(text, proxyOrigin) {
  return text.replace(/(?:https?:)?\/\/[^\s"'`<>\\]+/g,
    (url) => rewriteUrl(url, proxyOrigin));
}

function requestHeaders(request, target) {
  const headers = new Headers(request.headers);
  for (const key of HOP_BY_HOP) headers.delete(key);
  for (const key of [...headers.keys()]) {
    if (/^(cf-|x-forwarded-|x-real-ip$)/i.test(key)) headers.delete(key);
  }
  headers.delete('host');
  // An Origin/Referer from the proxy domain is meaningless to the upstream;
  // retain the upstream site's expected origin for CSRF checks and gameplay.
  if (headers.has('origin')) headers.set('origin', SITE.origin);
  if (headers.has('referer')) headers.set('referer', SITE.origin + '/');
  if (target.origin === ASSETS.origin) {
    // /config/ only serves public assets. Never send login credentials there.
    headers.delete('cookie');
    headers.delete('authorization');
  }
  return headers;
}

function responseHeaders(upstream, proxyOrigin, target) {
  const headers = new Headers(upstream.headers);
  for (const key of HOP_BY_HOP) headers.delete(key);
  for (const key of [...headers.keys()]) {
    if (/^(cf-|x-forwarded-)/i.test(key)) headers.delete(key);
  }
  const location = headers.get('location');
  if (location) {
    // Relative redirects from /config/ also need to stay on the Worker.
    try {
      const absolute = new URL(location, target);
      const rewritten = rewriteUrl(absolute.href, proxyOrigin);
      if (rewritten !== absolute.href) headers.set('location', rewritten);
    } catch { /* Keep an unusual upstream Location header unchanged. */ }
  }
  // Frame headers refer to the origin server rather than this Worker, and
  // narrow.one CSP can block its own rewritten assets / Worker scripts.
  headers.delete('content-security-policy');
  headers.delete('content-security-policy-report-only');
  headers.delete('x-frame-options');
  // A Domain=narrow.one cookie is rejected by browsers on the proxy hostname.
  // Make it host-only; HttpOnly, SameSite, Secure, Path etc. are preserved.
  if (target.origin === SITE.origin) {
    const cookies = upstream.headers.getSetCookie?.() ??
      upstream.headers.getAll?.('Set-Cookie') ??
      (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')] : []);
    if (cookies.length) {
      headers.delete('set-cookie');
      for (const cookie of cookies) {
        headers.append('set-cookie', cookie.replace(/;\s*Domain=\.?narrow\.one(?=\s*;|\s*$)/ig, ''));
      }
    }
  } else {
    headers.delete('set-cookie');
  }
  return headers;
}

const ISSUERS = new Set([
  'https://accounts.google.com', 'https://discord.com', 'https://itch.io',
  'https://www.facebook.com', 'https://appleid.apple.com',
]);

async function issuerConfig(request, url, fetchUpstream) {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
  const params = url.searchParams;
  if ([...params.keys()].some((key) => key !== 'issuer') ||
      params.getAll('issuer').length !== 1 || !ISSUERS.has(params.get('issuer'))) {
    return new Response('Invalid issuer', { status: 400 });
  }
  const target = new URL('/api/auth/getIssuerConfig', ASSETS);
  target.searchParams.set('issuer', params.get('issuer'));
  try {
    // Only public provider configuration; never forward cookies, authorization,
    // arbitrary headers or redirect to another host.
    const upstream = await fetchUpstream(new Request(target, { redirect: 'manual' }));
    if (upstream.status >= 300 && upstream.status < 400) return new Response('Issuer configuration unavailable', { status: 502 });
    return new Response(upstream.body, { status: upstream.status, headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    } });
  } catch {
    return new Response('Issuer configuration unavailable', { status: 502 });
  }
}

export async function handleRequest(request, fetchUpstream = fetch) {
  const url = new URL(request.url);
  if (url.pathname === '/__peli_public_probe') {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    try {
      const response = await fetchUpstream(new Request('https://pelicanparty.games/login', { redirect: 'manual' }));
      const html = await response.text();
      // Return only public page structure. Do not copy HTML, query strings,
      // cookies, passkey challenges, headers or per-request values.
      const paths = new Set();
      for (const match of html.matchAll(/(?:src|href|action|content)\s*=\s*["']([^"']+)["']/gi)) {
        try {
          const found = new URL(match[1], 'https://pelicanparty.games/login');
          if (found.origin === 'https://pelicanparty.games' && /^\/(?:static|auth|login|signup|account)(?:\/|$)/.test(found.pathname)) paths.add(found.pathname);
        } catch { /* Not a URL. */ }
      }
      return Response.json({ status: response.status, paths: [...paths].sort() }, { headers: { 'cache-control': 'no-store' } });
    } catch {
      return Response.json({ error: 'upstream unavailable' }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }
  if (url.pathname.startsWith('/__narrow_peli_sdk/')) return proxyPelicanSdk(request, url, fetchUpstream);
  if (url.pathname === '/__narrow_login/issuer') return issuerConfig(request, url, fetchUpstream);
  if (url.pathname === '/__narrow_login/assist.js') {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    return new Response(request.method === 'HEAD' ? null : LOGIN_ASSIST_SCRIPT, { headers: {
      'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    } });
  }
  const target = upstreamFor(url);
  const isWebSocket = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  const headers = requestHeaders(request, target);
  if (isWebSocket) headers.set('upgrade', 'websocket');

  const init = {
    method: request.method,
    headers,
    // Streaming request bodies are supported, including POST/PUT auth calls.
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  };
  if (init.body) init.duplex = 'half';
  let upstream;
  try {
    upstream = await fetchUpstream(new Request(target, init));
  } catch (error) {
    console.error('Upstream request failed', target.origin, error);
    return new Response('Upstream unavailable', { status: 502 });
  }

  // A 101 must retain the upstream WebSocket. Constructing a new Response
  // without its webSocket property would silently break game traffic.
  if (upstream.status === 101) return upstream;

  const outHeaders = responseHeaders(upstream, url.origin, target);
  const type = upstream.headers.get('content-type') ?? '';
  const canRewrite = request.method !== 'HEAD' && upstream.status === 200 &&
    !request.headers.has('range') && TEXT_TYPES.test(type);
  if (canRewrite) {
    let text = rewriteText(await upstream.text(), url.origin);
    if (/^\/(?:js\/)?index-[^/]+\.js$/i.test(url.pathname) &&
        /(?:javascript|x-javascript)\b/i.test(type)) {
      text = patchPelicanSdkImport(waitForPelicanSdk(text));
    }
    // Install only on game documents, before its deferred module scripts. This
    // does not alter the upstream bundle, OAuth URLs, or callback origin.
    if (/^text\/html\b/i.test(type) && /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/index-[^"']*\.js/i.test(text)) {
      text = text.replace(/<head\b[^>]*>/i, '$&<script src="/__narrow_login/assist.js"></script>');
    }
    // The entity has changed; compressed size, checksums and byte ranges from
    // the upstream representation are no longer valid.
    for (const key of ['content-length', 'content-encoding', 'etag', 'content-md5',
      'accept-ranges', 'content-range']) outHeaders.delete(key);
    outHeaders.set('cache-control', 'no-store');
    return new Response(text, { status: upstream.status, headers: outHeaders });
  }
  // Stream GLB, nasset, bin, WASM, images, range/206 and all other responses
  // directly: no arrayBuffer(), no base64 conversion and no size limit.
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

export default {
  fetch(request) {
    return handleRequest(request);
  },
};
