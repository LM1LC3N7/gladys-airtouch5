// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake console on a real local TCP
// socket, a virtual clock and a /data in memory.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AirTouchApp } from '../../src/app.js';
import { tcpConnect } from '../../src/airtouch/session.js';
import { buildAc, buildZone } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { parseAbility } from '../../src/airtouch/protocol.js';
import { abilityFrame, defaultSystem, fakeConsole } from './fakeConsole.js';
import { settle, testClock, waitFor } from './clock.js';

export const SELECTOR = 'airtouch5';
export const CONSOLE_ID = 'at5n2025000001';
export const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** The external id of a feature: `F('ac', 0, 'power')`. */
export const F = (kind, n, key, consoleKey = CONSOLE_ID) =>
  `ext:${SELECTOR}:airtouch5:${consoleKey}:${kind}${n}${key ? `:${key}` : ''}`;

/** The devices of the default system, as the user created them. */
export function createdDevices(consoleKey = CONSOLE_ID, system = defaultSystem()) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const abilities = parseAbility(abilityFrame(1, system.abilities).subarray(12, -2));
  const devices = abilities.map((ability) =>
    buildAc(gladys, { consoleKey, ability, number: ability.ac }, { language: 'en' }),
  );
  for (const z of system.zones) {
    const ability = abilities.find(
      (a) => z.zone >= a.startZone && z.zone < a.startZone + a.zoneCount,
    );
    devices.push(
      buildZone(
        gladys,
        {
          consoleKey,
          number: z.zone,
          name: system.names.get(z.zone),
          hasSensor: z.hasSensor,
          range: { min: 18, max: 30 },
          ac: ability?.ac,
        },
        { language: 'en' },
      ),
    );
  }
  return devices;
}

/**
 * `identity`: what the UDP identification answers (a console id, or
 * undefined for no answer); `config`: merged over the address of the fake.
 */
export async function setup(t, options = {}) {
  const clock = options.clock ?? testClock();
  const dev = options.dev ?? (await fakeConsole(options.console));
  const store = options.store ?? memoryStore(options.data ?? null);
  const identity = {
    consoleId: Object.hasOwn(options, 'identity') ? options.identity : CONSOLE_ID,
    calls: 0,
  };
  const config = options.noAddress
    ? { ...options.config }
    : { address: `127.0.0.1:${dev.port}`, language: 'en', ...options.config };
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: options.devices ?? createdDevices(),
  });
  // The client sockets open at once (one connection to the console at a time).
  const sockets = { open: 0, peak: 0, made: 0 };
  const connect = async (args) => {
    const socket = await tcpConnect(args);
    sockets.made += 1;
    sockets.open += 1;
    sockets.peak = Math.max(sockets.peak, sockets.open);
    socket.once('close', () => {
      sockets.open -= 1;
    });
    return socket;
  };
  const app = new AirTouchApp({
    connect,
    gladys,
    logger: quiet,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    identify: async ({ isCancelled }) => {
      identity.calls += 1;
      if (isCancelled()) return undefined;
      return identity.consoleId ? { consoleId: identity.consoleId } : undefined;
    },
    resolveHost: async () => '127.0.0.1',
    ...options.app,
  });
  registerHandlers(gladys, app, quiet);
  t.after(async () => {
    // The final save is bounded on the virtual clock: never awaited for long here.
    await Promise.race([app.stop(), new Promise((resolve) => setTimeout(resolve, 100))]);
    await dev.close();
  });
  if (options.connect !== false) {
    await gladys.connect();
  }
  return { app, gladys, dev, clock, store, identity, sockets };
}

/** Advances the virtual clock until `condition()` (real I/O runs in between), bounded. */
export async function until(clock, condition, what, { step = 10, max = 30_000 } = {}) {
  for (let spent = 0; spent <= max; spent += step) {
    await settle(3);
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
    await clock.advance(step);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The answer of a click, the virtual clock run until it comes (bounded: a
 * test fails, never hangs, even when a mutant keeps the command waiting).
 */
export async function answer(ctx, promise, { step = 5, max = 30_000 } = {}) {
  const box = { done: false };
  const settled = promise.then(
    (value) => {
      box.done = true;
      return value;
    },
    (err) => {
      box.done = true;
      throw err;
    },
  );
  await until(ctx.clock, () => box.done, 'answer', { step, max });
  return settled;
}

/** Waits until no read runs and one ended (online known). */
export async function idle(ctx) {
  await until(ctx.clock, () => ctx.app.online !== undefined && !ctx.app.running, 'read ended', {
    step: 5,
  });
  await settle(5);
}

/** Runs the first read and waits until the states are published. */
export async function firstRead(ctx) {
  const { clock, app } = ctx;
  await until(clock, () => app.live() && app.zones.size > 0 && app.acs.size > 0, 'first read');
  await settle(5);
}

export { settle, waitFor };
