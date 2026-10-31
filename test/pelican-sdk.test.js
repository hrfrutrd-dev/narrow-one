import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { handleRequest, waitForPelicanSdk } from '../src/worker.js';
import { installLoginAssist } from '../src/login-assist.js';

// Structure observed in the public 2026-10-31 bundle. The remainder is a
// minimal test harness, not a copy of the game.
const fixture = 'class $n{async showLoginDialog(t="login"){const e=new jn(this.gameWrapper,t);po().dialogManager.addDialog(e);return await e.waitForFlowEnd()}};/* getPeliSdkAsync() */ globalThis.auth=new $n();';

async function patchedGame(ready) {
  const events = [];
  let sdk = null;
  let finish;
  const sdkPromise = new Promise(resolve => { finish = () => { sdk = ready ? {} : null; resolve(sdk); }; });
  let dialogs = 0;
  const sandbox = {
    po: () => ({ getPeliSdkAsync: () => sdkPromise, getPeliSdk: () => sdk,
      dialogManager: { addDialog: () => dialogs++ } }),
    jn: class { waitForFlowEnd() { return 'finished'; } },
    window: { dispatchEvent: event => events.push(event.type) },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout() {},
  };
  vm.runInNewContext(waitForPelicanSdk(fixture), sandbox);
  const result = sandbox.auth.showLoginDialog();
  assert.equal(dialogs, 0);
  finish();
  assert.equal(await result, 'finished');
  return { dialogs, events };
}

test('login dialog waits for the Pelican SDK before deciding which buttons to show', async () => {
  assert.deepEqual(await patchedGame(true), { dialogs: 1, events: [] });
  assert.deepEqual(await patchedGame(false), { dialogs: 1, events: ['narrow-peli-sdk-unavailable'] });
});

test('a stalled SDK does not block the login dialog indefinitely', async () => {
  let expire;
  const events = [];
  const sandbox = {
    po: () => ({ getPeliSdkAsync: () => new Promise(() => {}), getPeliSdk: () => null,
      dialogManager: { addDialog() {} } }),
    jn: class { waitForFlowEnd() { return 'finished'; } },
    window: { dispatchEvent: event => events.push(event.type) },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout: (cb, ms) => { assert.equal(ms, 5000); expire = cb; },
  };
  vm.runInNewContext(waitForPelicanSdk(fixture), sandbox);
  const result = sandbox.auth.showLoginDialog();
  expire();
  assert.equal(await result, 'finished');
  assert.deepEqual(events, ['narrow-peli-sdk-unavailable']);
});

test('unknown or ambiguous upstream code is not patched', () => {
  assert.equal(waitForPelicanSdk('async showLoginDialog() {}'), 'async showLoginDialog() {}');
  const duplicate = fixture + fixture;
  assert.equal(waitForPelicanSdk(duplicate), duplicate);
});

test('patch applies only to game index JavaScript, not unrelated text', async () => {
  const response = () => new Response(fixture, { headers: { 'content-type': 'application/javascript' } });
  const game = await handleRequest(new Request('https://example.workers.dev/js/index-CGd_1Yik.js'), response);
  assert.match(await game.text(), /narrow-peli-sdk-unavailable/);
  const other = await handleRequest(new Request('https://example.workers.dev/js/other.js'), response);
  assert.equal(await other.text(), fixture);
});

test('missing Pelican SDK shows an actionable warning', () => {
  const elements = new Map(), listeners = new Map();
  const doc = { getElementById: id => elements.get(id),
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {},
      append(...children) { children.forEach(child => child.id && elements.set(child.id, child)); } }),
    body: { appendChild: node => elements.set(node.id, node) } };
  const win = { document: doc, fetch: async () => new Response(),
    addEventListener: (name, cb) => listeners.set(name, cb) };
  installLoginAssist(win);
  listeners.get('narrow-peli-sdk-unavailable')();
  assert.match(elements.get('narrow-login-assist-text').textContent, /Pelican Party/);
});
