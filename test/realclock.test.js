// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout, sped
// up 20 times) and a real local TCP console: the reads start at 0, the
// interval and twice the interval (never early, a little late under load at
// most), with a bounded number of timers; nothing is left running after stop.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AirTouchApp } from '../src/app.js';
import { POLL_INTERVAL } from '../src/constants.js';
import { memoryStore } from '../src/store.js';
import { fakeConsole } from './helpers/fakeConsole.js';
import { createdDevices, quiet } from './helpers/app.js';

const SPEED = 20;

test('real clock: reads at 0, the interval and twice the interval; timers bounded', async (t) => {
  const dev = await fakeConsole();
  const live = new Set();
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      const h = setTimeout(
        () => {
          live.delete(h);
          fn();
        },
        Math.max(0, ms) / SPEED,
      );
      live.add(h);
      return h;
    },
    clearTimeout(h) {
      live.delete(h);
      clearTimeout(h);
    },
    setInterval(fn, ms) {
      const h = setInterval(fn, Math.max(1, ms) / SPEED);
      live.add(h);
      return h;
    },
    clearInterval(h) {
      live.delete(h);
      clearInterval(h);
    },
  };
  const gladys = createFakeGladys({
    selector: 'airtouch5',
    config: { address: `127.0.0.1:${dev.port}`, poll_interval: POLL_INTERVAL.min },
    devices: createdDevices(),
  });
  await gladys.connect();
  const app = new AirTouchApp({
    gladys,
    logger: quiet,
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: memoryStore(),
    identify: async () => ({ consoleId: 'at5n2025000001' }),
    resolveHost: async () => '127.0.0.1',
  });
  const reads = [];
  const original = app.read.bind(app);
  app.read = () => {
    reads.push(performance.now() * SPEED);
    return original();
  };
  t.after(async () => {
    await Promise.race([app.stop(), new Promise((resolve) => setTimeout(resolve, 500))]);
    for (const h of live) {
      clearTimeout(h);
      clearInterval(h);
    }
    await dev.close();
  });
  await app.connected();
  const period = POLL_INTERVAL.min * 1000;
  const deadline = performance.now() + (3 * period) / SPEED + 3000;
  while (reads.length < 3 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(reads.length, 3, `${reads.length} reads`);
  const gaps = reads.slice(1).map((v, i) => v - reads[i]);
  for (const gap of gaps) {
    assert.ok(gap >= period * 0.98 && gap <= period * 1.5, `gap ${Math.round(gap)} ms`);
  }
  assert.ok(timersSet < 40, `${timersSet} timers`);
  await app.stop();
  // Nothing after stop: no read, no request (a request written just before it
  // may still be on its way to the console: counted after a short real wait).
  await new Promise((resolve) => setTimeout(resolve, 100));
  const frames = dev.frames.length;
  await new Promise((resolve) => setTimeout(resolve, (2 * period) / SPEED));
  assert.equal(dev.frames.length, frames);
  assert.equal(reads.length, 3);
});
