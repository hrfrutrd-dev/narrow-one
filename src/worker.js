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

// Only literal URL references in text files need replacement. Relative paths
// already resolve against the Worker; do not inspect/alter binary responses.
export function rewriteText(text, proxyOrigin) {
  return text.replace(/(?:https?:)?\/\/(?:narrow\.one|narrow-one\.com)(?=[/?:#\s"'`<>\\]|$)(?:[^\s"'`<>\\]*)/g,
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

export async function handleRequest(request, fetchUpstream = fetch) {
  const url = new URL(request.url);
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
    const text = rewriteText(await upstream.text(), url.origin);
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
