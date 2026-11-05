// -----------------------------------------------------------------------------
// /data: a plain file only, bounded, written whole; read back repaired.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory, serializeMemory } from '../src/store.js';

async function dir(t) {
  const path = await mkdtemp(join(tmpdir(), 'airtouch5-store-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('round trip, 0600, no file = null', async (t) => {
  const path = join(await dir(t), 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await store.save({ format: 1, attemptAt: 5 });
  assert.deepEqual(await store.load(), { format: 1, attemptAt: 5 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('a FIFO, a link or a huge file is refused, never waited for', async (t) => {
  const base = await dir(t);
  const fifo = join(base, 'fifo.json');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(fileStore(fifo).load(), (err) => ['ESPECIAL', 'ENXIO'].includes(err.code));
  const target = join(base, 'real.json');
  await writeFile(target, '{}');
  const link = join(base, 'link.json');
  await symlink(target, link);
  await assert.rejects(fileStore(link).load(), (err) => err.code === 'ELOOP');
  const huge = join(base, 'huge.json');
  await writeFile(huge, `"${'x'.repeat(70 * 1024)}"`);
  await assert.rejects(fileStore(huge).load(), (err) => err.code === 'EFBIG');
  // A save over a FIFO temporary is refused too (never blocks).
  const dest = join(base, 'dest.json');
  execFileSync('mkfifo', [`${dest}.tmp`]);
  await assert.rejects(fileStore(dest).save({ a: 1 }));
});

test('read back: unknown keys dropped, dates in the future brought to now, guards checked', () => {
  const now = 1_000_000;
  const memory = normalizeMemory(
    JSON.parse(
      JSON.stringify({
        format: 1,
        address: '192.168.1.4',
        id: 'at5n2025000001',
        consoleId: 'AT5N!',
        attemptAt: now + 5_000,
        evil: true,
        guards: [
          { id: 'at5n2025000001', target: 'ac:0', sent: true, confirmed: false, resends: 'x' },
          { id: 'at5n2025000001', target: 'ac:0', sent: false },
          { id: 'at5n2025000001', target: 'zone:64' },
          { id: '../x', target: 'zone:1' },
          { id: 'at5n2025000001', target: 'zone:3', resends: 2 },
        ],
      }),
    ),
    now,
  );
  assert.equal(memory.attemptAt, now);
  assert.equal(memory.consoleId, undefined);
  assert.deepEqual(memory.guards, [
    { id: 'at5n2025000001', target: 'ac:0', sent: true, confirmed: false, resends: 0 },
    { id: 'at5n2025000001', target: 'zone:3', sent: false, confirmed: false, resends: 2 },
  ]);
  assert.equal(Object.hasOwn(serializeMemory(memory), 'evil'), false);
  assert.deepEqual(
    normalizeMemory(JSON.parse('{"__proto__":{"id":"at5n2025000001"}}'), now).id,
    undefined,
  );
});
