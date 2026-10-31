// Runs before the upstream game. Keep OAuth pages and callbacks on their
// original origins; only retry the public issuer-config GET via the Worker.
export function installLoginAssist(win) {
  const originalFetch = win.fetch.bind(win);
  const apiOrigin = 'https://narrow-one.com';
  const configPath = '/api/auth/getIssuerConfig';
  const sessionPaths = new Set(['/api/auth/getSession', '/api/auth/linkNewAccount']);

  function showError(message) {
    const doc = win.document;
    let box = doc.getElementById('narrow-login-assist');
    if (!box) {
      box = doc.createElement('div');
      box.id = 'narrow-login-assist';
      box.setAttribute('role', 'alert');
      box.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:20px;transform:translateX(-50%);max-width:min(90vw,580px);padding:14px 18px;background:#fff4e3;color:#442b20;border:2px solid #855c40;border-radius:10px;box-shadow:0 3px 12px #0006;font:14px/1.5 sans-serif;';
      const text = doc.createElement('span');
      text.id = 'narrow-login-assist-text';
      const close = doc.createElement('button');
      close.type = 'button';
      close.textContent = '閉じる';
      close.style.cssText = 'display:block;margin:8px 0 0 auto;cursor:pointer;';
      close.addEventListener('click', () => box.remove());
      box.append(text, close);
      (doc.body || doc.documentElement).appendChild(box);
    }
    doc.getElementById('narrow-login-assist-text').textContent = message;
  }

  // Emitted only by the exact-version login-dialog compatibility patch. A
  // timeout may mean the SDK is still loading, so users can retry the dialog.
  win.addEventListener('narrow-peli-sdk-unavailable', () => {
    showError('Pelican Partyログインの準備ができませんでした。通信やブラウザー設定を確認し、少し待ってからログイン画面を開き直してください。解決しない場合は開発者ツールのSDKエラーを確認してください。');
  });

  win.fetch = async function (input, init) {
    let url, method;
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, win.location.href);
      method = (init?.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    } catch {
      return originalFetch(input, init);
    }
    const issuerRequest = url.origin === apiOrigin && url.pathname === configPath && method === 'GET';
    const sessionRequest = url.origin === apiOrigin && sessionPaths.has(url.pathname) && method === 'POST';
    if (!issuerRequest && !sessionRequest) return originalFetch(input, init);

    let response;
    try {
      response = await originalFetch(input, init);
    } catch (error) {
      // An aborted login must stay aborted. Never retry a POST carrying tokens.
      if (error?.name === 'AbortError') throw error;
      if (issuerRequest) {
        const retry = new URL('/__narrow_login/issuer', win.location.origin);
        retry.search = url.search;
        try {
          const signal = init?.signal || (typeof input === 'object' && input.signal);
          response = await originalFetch(retry.href, { method: 'GET', credentials: 'omit', signal });
        } catch (retryError) {
          if (retryError?.name !== 'AbortError') showError('ログイン設定を取得できません。接続を確認して再度お試しください。');
          throw retryError;
        }
      } else {
        showError('認証後のゲームセッションを取得できませんでした。通信設定やサードパーティCookieを確認してください。');
        throw error;
      }
    }
    if (!response.ok) {
      if (issuerRequest) showError(`ログイン設定を取得できませんでした（HTTP ${response.status}）。時間をおいて再度お試しください。`);
      else showError(`認証後のゲームセッションを取得できませんでした（HTTP ${response.status}）。上流の認証設定を確認してください。`);
    } else if (issuerRequest) {
      // The callback HTML observed on 2026-10-31 permits narrow.one, specific
      // Poki domains, or its own hostname. It rejects arbitrary Worker origins.
      // This is a warning only, not a replacement for the server's check.
      const current = new URL(win.location.href);
      const host = current.hostname;
      const allowed = ['http:', 'https:'].includes(current.protocol) && (
        host === 'narrow.one' || host.endsWith('.narrow.one') ||
        host === 'narrow-one.com' ||
        host === 'e2c6282e-13db-47a4-99c8-3297118978c1.poki-gdn.com' ||
        host === 'e2c6282e-13db-47a4-99c8-3297118978c1.gdn.poki.com'
      );
      if (!allowed) showError('現在のドメインは上流の認証コールバックで許可されていない可能性があります。認証後に「invalid origin」と表示される場合、上流運営者による許可設定が必要です。公式サイトでもログインできますが、こちらのセッションとは共有されません。');
    }
    return response;
  };
}

export const LOGIN_ASSIST_SCRIPT = `(${installLoginAssist.toString()})(window);`;
