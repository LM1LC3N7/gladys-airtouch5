// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), in one small JSON file readable by the container user only
// (0600), written through a temporary file, fsync and rename:
//   - the address of the console (a stop kept here can leave after a
//     restart before the configuration of Gladys is read);
//   - the id of the devices, chosen once (the console id, or the readable
//     fallback "a-<address>"), and the console id last read (the identity);
//   - the time of the last read attempt (a restart never reads sooner);
//   - the stops to apply (guards): sent or not yet, until a read shows them.
// Nothing secret: the protocol has no password.
//
// Bounded: the file is opened without following a link and without waiting
// (a FIFO or another special file is refused, never read), 64 KB at most;
// a save never waits more than `queueWait` for the one before it. The app
// also bounds every load and save (src/app.js): a /data that does not answer
// is unreadable or not written, never a wait.
// -----------------------------------------------------------------------------

import * as fsPromises from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { LIMITS, TIMINGS } from './constants.js';

export const STATE_FILE = '/data/airtouch5-state.json';
export const FORMAT = 1;
const MAX_BYTES = 64 * 1024;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

export function fileStore(
  path = STATE_FILE,
  { fs = fsPromises, timers = globalThis, queueWait = TIMINGS.storeQueue } = {},
) {
  let previous = Promise.resolve();
  let count = 0;
  let placed = 0;
  let sharedBusy = false;
  return {
    /** null when there is no file; throws when it cannot be read, is not a plain file or does not parse. */
    async load() {
      let handle;
      try {
        handle = await fs.open(path, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
      } catch (err) {
        if (err?.code === 'ENOENT') {
          return null;
        }
        throw err;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) {
          throw Object.assign(new Error('not a plain file'), { code: 'ESPECIAL' });
        }
        if (stat.size > MAX_BYTES) {
          throw Object.assign(new Error('state file too large'), { code: 'EFBIG' });
        }
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) {
          throw Object.assign(new Error('state file too large'), { code: 'EFBIG' });
        }
        return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally {
        await handle.close().catch(() => {});
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const seq = ++count;
      const before = previous;
      const write = (async () => {
        let timer;
        await Promise.race([
          before,
          new Promise((resolve) => {
            timer = timers.setTimeout(resolve, queueWait);
          }),
        ]);
        timers.clearTimeout(timer);
        const shared = !sharedBusy;
        if (shared) sharedBusy = true;
        const temporary = shared ? `${path}.tmp` : `${path}.tmp-${seq}`;
        try {
          const file = await fs.open(
            temporary,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW | NONBLOCK,
            0o600,
          );
          try {
            const stat = await file.stat();
            if (!stat.isFile()) {
              throw Object.assign(new Error('not a plain file'), { code: 'ESPECIAL' });
            }
            await file.writeFile(text, 'utf8');
            await file.sync();
          } finally {
            await file.close().catch(() => {});
          }
          if (seq < placed) {
            // A newer state is in place (this write hung meanwhile): never put back over it.
            await fs.unlink(temporary).catch(() => {});
            return;
          }
          await fs.rename(temporary, path);
          placed = Math.max(placed, seq);
        } finally {
          if (shared) sharedBusy = false;
        }
      })();
      previous = write.catch(() => {});
      return write;
    },
  };
}

/** The same in memory (tests): `fail` makes the saves throw, `unreadable` the loads, `hang` both wait forever. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : structuredClone(initial),
    saves: 0,
    loads: 0,
    fail: false,
    unreadable: false,
    hang: false,
    async load() {
      this.loads += 1;
      if (this.hang) return new Promise(() => {});
      if (this.unreadable) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      if (this.hang) return new Promise(() => {});
      if (this.fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

const ADDRESS = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const ID = /^[a-z0-9-]{4,80}$/;
const CONSOLE = /^[a-z0-9]{4,40}$/;
const TARGET = /^(ac|zone):(\d{1,2})$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A target "ac:<n>" | "zone:<n>" within the protocol ranges, else undefined. */
export function parseTarget(text) {
  const match = typeof text === 'string' ? TARGET.exec(text) : null;
  if (!match) return undefined;
  const number = Number(match[2]);
  const max = match[1] === 'ac' ? LIMITS.acs : LIMITS.zones;
  return number < max ? { kind: match[1], number } : undefined;
}

export const emptyMemory = () => ({
  format: FORMAT,
  address: undefined,
  id: undefined,
  fallback: false,
  consoleId: undefined,
  attemptAt: 0,
  guards: [],
});

/**
 * The file read back, repaired: only known keys of the expected shape (never
 * an inherited or `__proto__` key). An attempt dated in the future (a clock
 * set back, a hand-edited file) counts as now: the next read waits a whole
 * interval, never longer.
 */
export function normalizeMemory(raw, now) {
  const memory = emptyMemory();
  const address = own(raw, 'address');
  memory.address = typeof address === 'string' && ADDRESS.test(address) ? address : undefined;
  const id = own(raw, 'id');
  memory.id = typeof id === 'string' && ID.test(id) ? id : undefined;
  memory.fallback = memory.id !== undefined && own(raw, 'fallback') === true;
  const consoleId = own(raw, 'consoleId');
  memory.consoleId =
    typeof consoleId === 'string' && CONSOLE.test(consoleId) ? consoleId : undefined;
  const attemptAt = own(raw, 'attemptAt');
  memory.attemptAt = Number.isFinite(attemptAt) && attemptAt > 0 ? Math.min(attemptAt, now) : 0;
  const guards = own(raw, 'guards');
  if (Array.isArray(guards)) {
    const seen = new Set();
    for (const entry of guards.slice(0, LIMITS.guards)) {
      const target = own(entry, 'target');
      const owner = own(entry, 'id');
      if (!parseTarget(target) || typeof owner !== 'string' || !ID.test(owner)) {
        continue;
      }
      const key = `${owner}:${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resends = own(entry, 'resends');
      memory.guards.push({
        id: owner,
        target,
        sent: own(entry, 'sent') === true,
        confirmed: own(entry, 'confirmed') === true,
        // An unreadable count is 0: the stop keeps its resends.
        resends: Number.isInteger(resends) && resends >= 0 ? Math.min(resends, 99) : 0,
      });
    }
  }
  return memory;
}

/** The persisted form (plain objects of validated keys only). */
export function serializeMemory(memory) {
  return {
    format: FORMAT,
    ...(memory.address ? { address: memory.address } : {}),
    ...(memory.id ? { id: memory.id, fallback: memory.fallback === true } : {}),
    ...(memory.consoleId ? { consoleId: memory.consoleId } : {}),
    attemptAt: memory.attemptAt,
    guards: memory.guards.slice(0, LIMITS.guards).map((g) => ({
      id: g.id,
      target: g.target,
      sent: g.sent === true,
      confirmed: g.confirmed === true,
      resends: g.resends,
    })),
  };
}
