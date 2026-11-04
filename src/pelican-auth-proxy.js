// Experimental Pelican email-login relay. This is deliberately not a generic
// proxy: both hosts, routes and methods are fixed, and cross-origin writes are
// rejected. No request/response bodies, cookies, codes or URLs are logged.
const SITE = 'https://pelicanparty.games';
const API = 'https://api.pelicanparty.games';
const SITE_PREFIX = '/__pelican/site';
const API_PREFIX = '/__pelican/api';
const COOKIE_PREFIX = 'n1peli_';
const NO_STORE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const SITE_GET = new Set(['/auth/popup', '/login', '/login/verification', '/signup']);
const SITE_POST = new Set(['/login', '/login/verification', '/login/verifyEmailToken', '/auth/thirdParty/fetchSdkAuthTokens']);
const API_PATHS = new Set(['/v1/auth/createServerCode', '/v1/auth/refreshToken', '/v1/auth/exchangeClientCode', '/v1/entitlements', '/v1/entitlements/proof']);

function allowedRoute(kind, path, method) {
  if (kind === 'site') {
    if (method === 'GET' || method === 'HEAD') return SITE_GET.has(path) || /^\/static\/[a-zA-Z0-9_./-]+$/.test(path);
    return method === 'POST' && SITE_POST.has(path);
  }
  return API_PATHS.has(path) && ['GET', 'HEAD', 'POST'].includes(method);
}

function inputCookies(value) {
  return (value || '').split(';').map(x => x.trim()).filter(x => x.startsWith(COOKIE_PREFIX))
    .map(x => x.slice(COOKIE_PREFIX.length)).join('; ');
}

function outputCookie(cookie) {
  const parts = cookie.split(';');
  const first = parts.shift().trim();
  const pos = first.indexOf('=');
  if (pos <= 0 || !/^[!#$%&'*+.^_`|~\w-]+$/.test(first.slice(0, pos))) return null;
  let path = '/';
  const attrs = [];
  for (const part of parts) {
    const trimmed = part.trim();
    const i = trimmed.indexOf('=');
    const key = (i < 0 ? trimmed : trimmed.slice(0, i)).toLowerCase();
    const value = i < 0 ? '' : trimmed.slice(i + 1);
    if (key === 'domain') {
      if (!/^\.?pelicanparty\.games$/i.test(value)) return null;
    } else if (key === 'path') {
      if (!value.startsWith('/') || value.includes('..') || value.includes('\\')) return null;
      path = value;
    } else if (trimmed) attrs.push(trimmed);
  }
  return COOKIE_PREFIX + first + '; Path=' + SITE_PREFIX + path + (attrs.length ? '; ' + attrs.join('; ') : '');
}

function proxiedLocation(value, base, proxyOrigin) {
  let parsed;
  try { parsed = new URL(value, base); } catch { return null; }
  if (parsed.origin !== SITE) return null;
  return proxyOrigin + SITE_PREFIX + parsed.pathname + parsed.search + parsed.hash;
}

function rewriteHtml(html, origin) {
  // Restrict changes to URL attributes; do not modify inline scripts/challenges.
  return html.replace(/\b(href|src|action|content)\s*=\s*(["'])([^"']*)\2/gi, (all, attr, quote, value) => {
    if (!value.startsWith('/') && !value.startsWith(SITE + '/')) return all;
    const rewritten = proxiedLocation(value, SITE + '/login', origin);
    return rewritten ? `${attr}=${quote}${rewritten}${quote}` : all;
  }).replace(/<body\b[^>]*>/i, '$&<p role="alert">実験的な中継: メールアドレスと確認コードはこのWorkerを通過します。パスキーは使用できません。</p>');
}

export async function proxyPelicanAuth(request, url, fetchUpstream) {
  const kind = url.pathname.startsWith(SITE_PREFIX + '/') ? 'site' : 'api';
  const prefix = kind === 'site' ? SITE_PREFIX : API_PREFIX;
  const path = url.pathname.slice(prefix.length);
  const method = request.method;
  const result = (body, status) => new Response(body, { status, headers: NO_STORE });
  if (!allowedRoute(kind, path, method) || path.includes('..') || path.includes('\\') || path.includes('%')) return result('Not found', 404);
  if (!['GET', 'HEAD'].includes(method) && request.headers.get('origin') !== url.origin) return result('Forbidden', 403);

  const headers = new Headers();
  for (const name of ['content-type', 'accept', 'accept-language']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (kind === 'site') {
    const cookie = inputCookies(request.headers.get('cookie'));
    if (cookie) headers.set('cookie', cookie);
  } else if (request.headers.has('authorization')) {
    headers.set('authorization', request.headers.get('authorization'));
  }
  if (!['GET', 'HEAD'].includes(method)) {
    headers.set('origin', kind === 'site' ? SITE : API);
    headers.set('referer', (kind === 'site' ? SITE : API) + '/');
  }
  const target = new URL(kind === 'site' ? SITE : API);
  target.pathname = path;
  target.search = url.search;
  let body;
  if (!['GET', 'HEAD'].includes(method)) {
    if (Number(request.headers.get('content-length') || 0) > 131072) return result('Request too large', 413);
    const reader = request.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 131072) { await reader.cancel(); return result('Request too large', 413); }
        chunks.push(value);
      }
    }
    body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  }
  let upstream;
  try { upstream = await fetchUpstream(new Request(target, { method, headers, body, redirect: 'manual' })); }
  catch { return result('Pelican Party unavailable', 502); }
  const out = new Headers(NO_STORE);
  for (const name of ['content-type', 'content-security-policy', 'x-frame-options', 'cross-origin-opener-policy']) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  if (kind === 'site') {
    const cookies = upstream.headers.getSetCookie?.() ?? upstream.headers.getAll?.('Set-Cookie') ??
      (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')] : []);
    for (const cookie of cookies) { const rewritten = outputCookie(cookie); if (rewritten) out.append('set-cookie', rewritten); }
  }
  const location = upstream.headers.get('location');
  if (location) {
    const rewritten = kind === 'site' && proxiedLocation(location, target, url.origin);
    if (!rewritten) return result('Unsupported Pelican redirect', 502);
    out.set('location', rewritten);
  }
  const type = upstream.headers.get('content-type') || '';
  if (kind === 'site' && method !== 'HEAD' && /^text\/html\b/i.test(type) && upstream.status === 200) {
    return new Response(rewriteHtml(await upstream.text(), url.origin), { status: upstream.status, headers: out });
  }
  if (kind === 'site' && method !== 'HEAD' && /^application\/json\b/i.test(type) && upstream.status === 200) {
    let data;
    try { data = await upstream.json(); } catch { return result('Invalid Pelican response', 502); }
    if (data && typeof data === 'object' && typeof data.url === 'string') {
      const rewritten = proxiedLocation(data.url, target, url.origin);
      if (!rewritten) return result('Unsupported Pelican redirect', 502);
      data.url = rewritten;
    }
    return new Response(JSON.stringify(data), { status: upstream.status, headers: out });
  }
  return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
}
