// This endpoint only serves the public Pelican SDK, without credentials.
// The separate experimental auth relay handles the SDK's fixed web/API routes.
const SDK = new URL('https://js.pelicanparty.games');
const PREFIX = '/__narrow_peli_sdk/';
const JS_TYPE = /^(?:text|application)\/(?:javascript|x-javascript)\b/i;

export function patchPelicanSdkImport(text) {
  // Observed in Narrow One's 2026-10-31 bundle. Fail closed if the minified
  // code changes or the same pattern occurs more than once.
  const before = 'const n=await import(s),{init:o}=n;';
  if (!text.includes('https://js.pelicanparty.games/v1.js') ||
      text.indexOf(before) < 0 || text.indexOf(before) !== text.lastIndexOf(before)) return text;
  const after = 'const n=await import("/__narrow_peli_sdk/v1.js"),{init:o}=n;';
  return text.replace(before, after);
}

export async function proxyPelicanSdk(request, url, fetchUpstream) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });
  }
  const path = url.pathname.slice(PREFIX.length);
  if (path !== 'v1.js' && !/^browserSdk\/[a-zA-Z0-9_-]+\.js$/.test(path)) {
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  const target = new URL(SDK);
  target.pathname = '/' + path;
  target.search = url.search;
  let upstream;
  try {
    // No browser cookies, credentials, Origin, Referer or custom headers.
    upstream = await fetchUpstream(new Request(target, { method: request.method, redirect: 'manual' }));
  } catch {
    return new Response('Pelican SDK unavailable', { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return new Response('Pelican SDK redirect not supported', { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  if (!upstream.ok) {
    return new Response('Pelican SDK unavailable', { status: upstream.status, headers: { 'cache-control': 'no-store' } });
  }
  const type = upstream.headers.get('content-type') || '';
  if (!JS_TYPE.test(type)) {
    return new Response('Unexpected Pelican SDK response', { status: 502, headers: { 'cache-control': 'no-store' } });
  }
  const headers = { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  let text = await upstream.text();
  // Preserve the SDK version/environment checks while routing its web and
  // API traffic through fixed Worker endpoints. Only patch the exact known SDK;
  // unknown versions fail closed instead of silently changing auth behavior.
  text = text.replaceAll('new URL(import.meta.url)', `new URL(${JSON.stringify(target.href)})`);
  if (path.startsWith('browserSdk/')) {
    const basePattern = /const s=function\(\)\{const e="https:\/\/api\.pelicanparty\.games\/";[\s\S]*?\}\(\);async function a\(/g;
    const site = 'function d(){const e=h();if("production"==e)return"https://pelicanparty.games";if("staging"==e)return"https://staging.pelicanparty.games";throw new Error("Unknown environment")}';
    const messageOrigin = 'if("production"==e)return"https://pelicanparty.games";if("staging"==e)return"https://staging.pelicanparty.games";throw new Error("Unknown environment")';
    if ([...text.matchAll(basePattern)].length !== 1 || !text.includes(site) ||
        text.indexOf(site) !== text.lastIndexOf(site)) {
      return new Response('Unsupported Pelican SDK version', { status: 502, headers: { 'cache-control': 'no-store' } });
    }
    text = text.replace(basePattern, 'const s=location.origin+"/__pelican/api/";async function a(');
    text = text.replace(site, 'function d(){return location.origin+"/__pelican/site"}');
    if (text.indexOf(messageOrigin) < 0 || text.indexOf(messageOrigin) !== text.lastIndexOf(messageOrigin)) {
      return new Response('Unsupported Pelican SDK version', { status: 502, headers: { 'cache-control': 'no-store' } });
    }
    text = text.replace(messageOrigin, 'if("production"==e||"staging"==e)return location.origin;throw new Error("Unknown environment")');
  }
  return new Response(text, { status: 200, headers });
}
