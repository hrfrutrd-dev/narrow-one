import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installLoginAssist } from '../src/login-assist.js';

function setup(pageOrigin) {
  const nodes = new Map();
  const doc = {
    getElementById: id => nodes.get(id),
    createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {}, remove() {},
      append(...children) { children.forEach(child => child.id && nodes.set(child.id, child)); } }),
    body: { appendChild: node => nodes.set(node.id, node) },
  };
  const win = { fetch: async () => new Response('{}'), document: doc, addEventListener() {},
    location: { href: pageOrigin + '/', origin: pageOrigin } };
  installLoginAssist(win);
  return { win, nodes };
}

const config = 'https://narrow-one.com/api/auth/getIssuerConfig?issuer=https%3A%2F%2Fdiscord.com';

test('warns about the observed callback origin restriction without changing the request', async () => {
  for (const origin of ['https://example.workers.dev', 'https://narrow.one.evil.example',
    'https://evil-narrow.one', 'https://custom.example']) {
    const { win, nodes } = setup(origin);
    assert.equal((await win.fetch(config)).status, 200);
    assert.match(nodes.get('narrow-login-assist-text').textContent, /invalid origin/);
  }
});

test('does not warn for origins permitted by the observed callback', async () => {
  for (const origin of ['https://narrow.one', 'https://staging.narrow.one',
    'https://narrow-one.com', 'https://e2c6282e-13db-47a4-99c8-3297118978c1.poki-gdn.com',
    'https://e2c6282e-13db-47a4-99c8-3297118978c1.gdn.poki.com']) {
    const { win, nodes } = setup(origin);
    assert.equal((await win.fetch(config)).status, 200);
    assert.equal(nodes.size, 0);
  }
});
