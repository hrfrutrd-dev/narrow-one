import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const wrangler = resolve('node_modules/.bin/wrangler');

test('the bundled Worker serves a standalone executable browser script',
  { skip: !existsSync(wrangler) && 'Run npm ci to test the Wrangler bundle' }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'narrow-worker-test-'));
    try {
      execFileSync(wrangler, ['deploy', '--dry-run', '--outdir', dir], {
        stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      });
      const bundle = await readFile(join(dir, 'worker.js'));
      const worker = await import('data:text/javascript;base64,' + bundle.toString('base64'));
      const res = await worker.handleRequest(new Request('https://example.workers.dev/__narrow_login/assist.js'));
      const script = await res.text();
      const elements = new Map(), listeners = new Map();
      const document = { getElementById: id => elements.get(id),
        createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {},
          append(...children) { children.forEach(child => child.id && elements.set(child.id, child)); } }),
        body: { appendChild: node => elements.set(node.id, node) } };
      const win = { document, fetch: async () => new Response(),
        addEventListener: (type, cb) => listeners.set(type, cb),
        location: { href: 'https://example.workers.dev/', origin: 'https://example.workers.dev' } };
      vm.runInNewContext(script, { window: win, URL });
      assert.equal(typeof listeners.get('narrow-peli-sdk-unavailable'), 'function');
      listeners.get('narrow-peli-sdk-unavailable')();
      assert.match(elements.get('narrow-login-assist-text').textContent, /Pelican Party/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
