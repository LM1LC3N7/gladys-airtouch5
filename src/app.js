// -----------------------------------------------------------------------------
// The integration: the AirTouch 5 console typed in the configuration, one TCP
// session to it at a time, its ACs and zones as Gladys devices, their states,
// the transport badges, the "Test the connection" button and the commands.
// index.js only wires the SDK (src/handlers.js).
//
// Two clocks: `now` (wall clock) dates only what /data keeps (the time of
// the last read attempt); `monotonic` paces the reads, the deadlines, the
// backoff and the publication budget. One read of the clock per decision.
//
// Reads: the AC and zone status every interval (the AC abilities, zone names
// and console version when the session opens, then every 6 hours), never
// sooner than the interval after the last attempt, whatever asks (a
// reconnection to Gladys, the Discovery tab, a configuration saved, the test
// button, a restart: the time of the attempt is kept in /data, written
// before the read at most once a minute). A failed session waits 30 s, 1, 2,
// then 5 min, never less than the interval. The console also sends a status
// by itself when something changes: it is shown as it comes.
//
// Identity: the console id (UDP identification, port 49005), checked at
// every session; until it is, or when another console answers, nothing is
// shown and only stops are sent (to the address typed).
//
// Stops (an AC or a zone switched off), the protective commands:
//   - never refused for the option, the identity, a read, a command or a
//     read back in progress, a missing configuration (the address and the
//     stops are kept in /data), nor before the first read; never skipped as
//     "already off";
//   - kept at once (a guard, saved to /data in the background: the stop
//     never waits for /data), they cancel the commands of the same target
//     still waiting, take the lane first, cut a request in flight that has
//     received nothing for a second, and leave together (one frame for the
//     ACs, one for the zones);
//   - a stop that could not leave is tried again for 250 ms, then kept and
//     sent first as soon as a session opens (tried every 10 s, 30 s, then
//     every minute); only a write counts as a try: a stop never sent is never
//     given up;
//   - confirmed by a status read after its write that shows the target off;
//     until then it is sent again by the reads that show the target on (3
//     times at most). Once confirmed, it is lifted by the target read on
//     twice in a row (switched on elsewhere) or by a command of the target
//     that left (a click); never by the time. Kept in /data until then.
// Other commands (behind the "Allow the commands" option): one at a time per
// target, decided on a status read just before (never on what was kept),
// option and deadline checked again right before the write, written within
// 3.5 s of the click or refused "nothing was sent", confirmed only by a
// status that shows the value asked (by 4.3 s), else "sent, without
// confirmation" and reads 5 s and 20 s later. Refused when /data cannot be
// written (a stop could not be kept), during a stop of the same target, or
// for a value outside what the console lists (setpoint limits, modes, fan
// speeds). The ack never waits for a publication to Gladys.
// -----------------------------------------------------------------------------

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig, parseAddress, unicastIPv4 } from './config.js';
import { FEATURES, KINDS, LIMITS, SECOND, STOP_RESENDS, TIMINGS } from './constants.js';
import {
  acStates,
  boundsOf,
  buildAc,
  buildZone,
  commandValue,
  deviceIds,
  fallbackId,
  fanCode,
  fansOf,
  modeCode,
  modesOf,
  parseExternalId,
  zoneStates,
} from './devices.js';
import { ERRORS, T, age, both, join, targetName, word } from './i18n.js';
import { Lane, LaneTimeout, PRIORITY } from './lane.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, normalizeMemory, parseTarget, serializeMemory } from './store.js';
import { queryIdentity } from './airtouch/discovery.js';
import {
  AC_POWER,
  KIND,
  ZONE_POWER,
  setpointRange,
  acAbilityRequest,
  acControl,
  acStatusRequest,
  versionRequest,
  zoneControl,
  zoneNameRequest,
  zoneStatusRequest,
} from './airtouch/protocol.js';
import { ERROR_KINDS, Session, SessionError, errorReason, tcpConnect } from './airtouch/session.js';

/** Resolves a host name to one unicast IPv4 address (an IP is returned as is). */
export async function lookupIPv4(host) {
  if (isIP(host) === 4) return host;
  const { address } = await lookup(host, { family: 4 });
  return address;
}

/** A promise bounded in time: `fallback` (or its throw) when it takes longer. */
function bounded(promise, ms, timers, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => timers.clearTimeout(timer));
}

const TIMEOUT = Symbol('timeout');
const targetKey = (target) => `${target.kind}:${target.number}`;

export class AirTouchApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'airtouch5' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
    connect = tcpConnect,
    identify = queryIdentity,
    resolveHost = lookupIPv4,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.connect = connect;
    this.identify = identify;
    this.resolveHost = resolveHost;
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
    this.lane = new Lane({ timers });
    this.config = undefined;
    this.memory = emptyMemory();
    /** 'unknown' (not loaded yet) | 'ok' | 'unreadable'. */
    this.memoryState = 'unknown';
    this.memoryLoading = undefined;
    this.writable = true;
    this.generation = 0;
    this.closed = false;
    this.booted = undefined;
    this.lifecycle = Promise.resolve();
    this.configFailures = 0;
    this.configTimer = undefined;
    this.configAt = undefined;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    /** Every frame read gets the next number, for life (a stop compares it to its write). */
    this.frameSeq = 0;
    this.resetConsole();
    /** `${console id}:${target}` -> the stop guard (see the header). */
    this.guards = new Map();
    this.stopRunner = undefined;
    this.stopRetry = { timer: undefined, tries: 0 };
    /** target key -> clicks of a stop not answered yet. */
    this.stopsInFlight = new Map();
    /** target key -> the tail of the commands of that target. */
    this.chains = new Map();
    /** target key -> the commands waiting or in flight, each { cancelled }. */
    this.commands = new Map();
    this.waitingCommands = 0;
    /** `${target}:${field}` -> { from, expected, moved, until }: sent, not seen yet. */
    this.commandGuards = new Map();
  }

  /** What is known of the console, reset when the address or the interval changes. */
  resetConsole() {
    this.session = undefined;
    this.opening = undefined;
    this.ip = undefined;
    this.identity = 'none';
    this.consoleKey = undefined;
    this.abilities = new Map();
    this.names = new Map();
    this.version = undefined;
    this.layoutAt = undefined;
    this.acs = new Map();
    this.zones = new Map();
    this.online = undefined;
    this.failures = 0;
    this.reason = undefined;
    this.nextReadAt = undefined;
    this.readTimer = undefined;
    this.running = undefined;
    this.followUps = new Set();
    this.attemptSavedAt = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Configurations apply one at a time, in order, the last one winning. */
  serialized(fn) {
    const run = this.lifecycle.then(fn, fn);
    this.lifecycle = run.catch((err) => this.logger.error(`AirTouch 5: ${err.message}`));
    return run;
  }

  /**
   * Connected to Gladys (the first time and after every reconnection): the
   * configuration is read (again until it comes, for life); the stops kept in
   * /data leave at once, before it.
   */
  async connected() {
    if (!this.booted) {
      this.booted = this.boot();
    }
    await this.booted;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    // A reconnection never republishes old states as new: the next status does.
    this.publisher.clear();
    this.gladys.forgetPublishedStates?.();
    await this.readConfig();
  }

  async boot() {
    await this.loadMemory();
    this.publisher.start();
    if (this.dueGuards().length > 0) {
      this.kickStops();
    }
  }

  /** getConfig(), tried again (5 s, 15 s, then every minute) until it answers, for life. */
  async readConfig() {
    if (this.closed) return;
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      const wait =
        TIMINGS.configRetry[Math.min(this.configFailures, TIMINGS.configRetry.length - 1)];
      this.configFailures += 1;
      this.configAt = this.monotonic() + wait;
      this.logger.warn(
        `Reading the configuration failed: ${err.message}; next try in ${wait / 1000} s`,
      );
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.readConfig().catch(() => {});
      }, wait);
      await this.updateStatus();
      return;
    }
    this.configFailures = 0;
    this.configAt = undefined;
    await this.applyConfig(raw ?? {});
  }

  /** The configuration saved by the user. */
  configUpdated(raw = {}) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
      this.configFailures = 0;
      this.configAt = undefined;
    }
    return this.applyConfig(raw);
  }

  applyConfig(raw) {
    // Commands turned off apply at once, before the queue.
    const next = normalizeConfig(raw);
    this.latestAllow = next.allowCommands;
    if (!next.allowCommands && this.config?.allowCommands) {
      this.config = { ...this.config, allowCommands: false };
      this.logger.info('AirTouch 5 commands disabled');
    }
    return this.serialized(() => this.doApplyConfig(raw));
  }

  async doApplyConfig(raw) {
    if (this.closed) return;
    const next = normalizeConfig(raw);
    // A configuration taken from the queue never turns back on commands turned off later.
    if (this.latestAllow === false) next.allowCommands = false;
    const previous = this.config;
    this.config = next;
    const restart =
      !previous ||
      previous.pollInterval !== next.pollInterval ||
      JSON.stringify(previous.address) !== JSON.stringify(next.address);
    if (previous && previous.allowCommands !== next.allowCommands) {
      this.logger.info(`AirTouch 5 commands ${next.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (!restart) {
      if (previous.language !== next.language) {
        this.published = undefined;
      }
      await this.publishAll();
      return;
    }
    await this.restart();
  }

  /** A new address or interval: a new session, the first read never sooner than the interval. */
  async restart() {
    this.generation += 1;
    const known = this.lastAttemptWall;
    this.closeSession('configuration changed');
    this.clearReadTimers();
    const stopsAddress = this.memory.address;
    this.resetConsole();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    const address = this.config.address;
    if (address) {
      const key = addressKey(address);
      if (key !== stopsAddress && this.memoryState === 'ok') {
        this.memory.address = key;
        await this.saveMemory();
      }
    }
    await this.publishAll();
    if (!address) return;
    // The time of the last attempt: exact in this process; from /data (a
    // container restart, written at most once a minute), at least a minute after it.
    const wall = this.now();
    const exact = known !== undefined;
    const attemptAt = exact ? known : this.memory.attemptAt;
    const wait = exact ? this.interval : Math.max(this.interval, TIMINGS.attemptSave);
    const delay = Math.min(wait, Math.max(0, attemptAt + wait - wall));
    this.scheduleRead(delay);
    if (this.dueGuards().length > 0) this.kickStops();
  }

  get interval() {
    return (this.config?.pollInterval ?? 60) * SECOND;
  }

  /** The address stops go to: the configuration, else the one kept in /data. */
  get stopAddress() {
    if (this.config) return this.config.address;
    return this.memory.address ? parseAddress(this.memory.address) : undefined;
  }

  clearReadTimers() {
    if (this.readTimer) {
      this.timers.clearTimeout(this.readTimer);
      this.readTimer = undefined;
    }
    for (const timer of this.followUps) this.timers.clearTimeout(timer);
    this.followUps = new Set();
  }

  /** The SDK shutdown: no timer, no request after it; /data written. */
  async stop() {
    this.closed = true;
    this.generation += 1;
    this.clearReadTimers();
    if (this.configTimer) this.timers.clearTimeout(this.configTimer);
    if (this.stopRetry.timer) this.timers.clearTimeout(this.stopRetry.timer);
    this.configTimer = undefined;
    this.stopRetry.timer = undefined;
    this.publisher.stop();
    this.closeSession('stopped');
    await this.saveMemory();
  }

  // --- /data -----------------------------------------------------------------

  /** Loads /data within its bound; unreadable is never taken for empty. */
  async loadMemory() {
    if (this.memoryLoading) return this.memoryLoading;
    this.memoryLoading = (async () => {
      let raw;
      try {
        raw = await bounded(this.store.load(), TIMINGS.storeLoad, this.timers, TIMEOUT);
      } catch (err) {
        this.logger.warn(`Reading /data failed: ${err.code ?? err.message}`);
        raw = TIMEOUT;
      }
      if (raw === TIMEOUT) {
        this.memoryState = 'unreadable';
        return;
      }
      const loaded = normalizeMemory(raw, this.now());
      // What this process learnt while /data was unreadable is kept.
      for (const guard of this.memory.guards ?? []) {
        if (!loaded.guards.some((g) => g.id === guard.id && g.target === guard.target)) {
          loaded.guards.push(guard);
        }
      }
      loaded.attemptAt = Math.max(loaded.attemptAt, this.memory.attemptAt ?? 0);
      this.memory = loaded;
      this.memoryState = 'ok';
      for (const g of loaded.guards) {
        const key = `${g.id}:${g.target}`;
        if (!this.guards.has(key)) {
          this.guards.set(key, {
            ...g,
            // Loaded: any status read from now on is after its write.
            afterSeq: -1,
            other: 0,
            due: !g.confirmed && (!g.sent || g.resends < STOP_RESENDS),
            waiters: [],
          });
        }
      }
    })().finally(() => {
      this.memoryLoading = undefined;
    });
    return this.memoryLoading;
  }

  /** Saves /data within its bound; false when it was not written (never over an unreadable file). */
  async saveMemory({ waitMs = TIMINGS.storeSave } = {}) {
    if (this.memoryState !== 'ok') {
      return false;
    }
    this.memory.guards = [...this.guards.values()]
      .slice(0, LIMITS.guards)
      .map(({ id, target, sent, confirmed, resends }) => ({
        id,
        target,
        sent,
        confirmed,
        resends,
      }));
    let ok;
    try {
      ok = await bounded(
        this.store.save(serializeMemory(this.memory)).then(() => true),
        Math.max(0, Math.min(TIMINGS.storeSave, waitMs)),
        this.timers,
        false,
      );
    } catch (err) {
      this.logger.warn(`Saving /data failed: ${err.code ?? err.message}`);
      ok = false;
    }
    if (ok !== this.writable) {
      this.writable = ok;
      this.lastStatus = undefined;
    }
    return ok;
  }

  /** A save in the background (a stop never waits for /data). */
  saveLater() {
    this.saveMemory().catch(() => {});
  }

  // --- Session ---------------------------------------------------------------

  /** The open session, or a new one (only after the previous one is closed). */
  async ensureSession({ deadline }) {
    if (this.session && !this.session.closed) {
      return this.session;
    }
    if (!this.opening) {
      this.opening = this.openSession().finally(() => {
        this.opening = undefined;
      });
    }
    const left = deadline - this.monotonic();
    const result = await bounded(this.opening, Math.max(0, left), this.timers, TIMEOUT);
    if (result === TIMEOUT) {
      throw new SessionError(ERROR_KINDS.LATE, 'too late');
    }
    return result;
  }

  async openSession() {
    const address = this.stopAddress;
    if (!address) {
      throw new SessionError(ERROR_KINDS.CONNECT, 'no address');
    }
    const generation = this.generation;
    // The last session, even one already closed: its socket may still be closing.
    const old = this.lastSession;
    if (old) {
      // One connection at a time: the new one only once the old socket is closed.
      old.close('replaced');
      await bounded(old.whenClosed, SECOND, this.timers, undefined);
    }
    const ip = await bounded(
      this.resolveHost(address.host),
      TIMINGS.connectTimeout,
      this.timers,
      undefined,
    );
    if (!ip || !unicastIPv4(ip)) {
      throw new SessionError(ERROR_KINDS.CONNECT, 'name not found', { code: 'ENOTFOUND' });
    }
    const socket = await this.connect({
      ip,
      port: address.port,
      timeoutMs: TIMINGS.connectTimeout,
      timers: this.timers,
    });
    if (generation !== this.generation || this.closed) {
      socket.destroy();
      throw new SessionError(ERROR_KINDS.CLOSED, 'configuration changed');
    }
    const session = new Session({
      socket,
      monotonic: this.monotonic,
      timers: this.timers,
      onFrame: (parsed) => this.onFrame(session, parsed),
      onClose: (reason) => this.sessionClosed(session, reason),
    });
    this.session = session;
    this.lastSession = session;
    this.ip = ip;
    this.identity = 'pending';
    this.consoleKey = undefined;
    // Nothing read on a previous session is shown for this one (it may be
    // another console): statuses and layout are read again.
    this.acs = new Map();
    this.zones = new Map();
    this.abilities = new Map();
    this.names = new Map();
    this.version = undefined;
    this.layoutAt = undefined;
    this.logger.info(`AirTouch 5: connected to ${addressKey(address)}`);
    // The stops kept leave first; the identity is checked meanwhile.
    if (this.dueGuards().length > 0) this.kickStops();
    this.checkIdentity(session).catch((err) =>
      this.logger.warn(`AirTouch 5 identity: ${err.message}`),
    );
    return session;
  }

  sessionClosed(session, reason) {
    if (this.session !== session) return;
    this.session = undefined;
    // The identity is checked again on the next session.
    this.identity = 'none';
    if (!this.closed) {
      this.logger.info(`AirTouch 5: session closed (${reason})`);
      this.lastStatus = undefined;
      this.publishBadge().catch(() => {});
    }
  }

  closeSession(reason) {
    this.session?.close(reason);
  }

  /**
   * One request on the lane: `priority`, waiting at most `waitMs` for its
   * turn; resolves the value of the answer.
   */
  async exchange(priority, build, { kind, waitBy, timeoutMs, answerBy, beforeSend, onWritten }) {
    const waitMs = waitBy - this.monotonic();
    if (!(waitMs > 0)) {
      throw new SessionError(ERROR_KINDS.LATE, 'too late');
    }
    const release = await this.lane.acquire(priority, { waitMs });
    try {
      const session = this.session;
      if (!session || session.closed) {
        throw new SessionError(ERROR_KINDS.CLOSED, 'not connected');
      }
      if (this.monotonic() > waitBy) {
        throw new SessionError(ERROR_KINDS.LATE, 'too late');
      }
      const left = answerBy !== undefined ? answerBy - this.monotonic() : timeoutMs;
      const value = await session.request(build, { kind, timeoutMs: left, beforeSend, onWritten });
      return { value, session };
    } finally {
      release();
    }
  }

  // --- Identity --------------------------------------------------------------

  /** One check at a time per session (a check of an older session never stands for a new one). */
  checkIdentity(session) {
    if (this.identityCheck?.session !== session) {
      const check = { session };
      check.promise = this.doCheckIdentity(session).finally(() => {
        if (this.identityCheck === check) this.identityCheck = undefined;
      });
      this.identityCheck = check;
    }
    return this.identityCheck.promise;
  }

  async doCheckIdentity(session) {
    const identity = await this.identify({
      ip: this.ip,
      tries: TIMINGS.identityTries,
      waitMs: TIMINGS.identityWait,
      timers: this.timers,
      isCancelled: () => this.session !== session,
    });
    if (this.session !== session) return;
    if (this.memoryState === 'unreadable') {
      await this.loadMemory();
      if (this.session !== session) return;
    }
    await this.decideIdentity(identity?.consoleId);
    this.lastStatus = undefined;
    if (this.session !== session) return;
    // The states read before the identity was checked, now that it is.
    this.queueFreshStates(this.createdFeatures());
    await this.publishAll();
  }

  /** The console ids of the devices created in Gladys. */
  createdConsoles() {
    const consoles = new Set();
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseExternalId(device?.external_id);
      if (parsed) consoles.add(parsed.console);
    }
    return consoles;
  }

  async decideIdentity(consoleId) {
    const fallback = fallbackId(addressKey(this.stopAddress));
    if (this.memoryState !== 'ok') {
      // /data unreadable: never a new identity; only the one the created devices prove.
      const created = this.createdConsoles();
      if (consoleId && created.has(consoleId)) {
        this.identity = 'ok';
        this.consoleKey = consoleId;
      } else if (!consoleId && created.has(fallback)) {
        this.identity = 'ok';
        this.consoleKey = fallback;
      } else {
        this.identity = 'unverified';
        this.consoleKey = undefined;
      }
      return;
    }
    const memory = this.memory;
    if (!memory.id) {
      // The id of the devices, chosen once: the console id, or the fallback when
      // the console did not give it (or devices were already created under it).
      const createdUnderFallback = this.createdConsoles().has(fallback);
      memory.fallback = !consoleId || createdUnderFallback;
      memory.id = memory.fallback ? fallback : consoleId;
      memory.consoleId = consoleId;
      // Chosen only once kept: a /data that refuses it would let a restart choose again.
      if (!(await this.saveMemory())) {
        memory.id = undefined;
        memory.fallback = false;
        memory.consoleId = undefined;
        this.identity = 'unsaved';
        this.consoleKey = undefined;
        return;
      }
      this.identity = 'ok';
    } else if (memory.consoleId) {
      if (!consoleId) {
        this.identity = 'unverified';
      } else {
        this.identity = consoleId === memory.consoleId ? 'ok' : 'other';
      }
    } else {
      // Never seen (fallback): the first one seen checks every later session.
      if (consoleId) memory.consoleId = consoleId;
      this.identity = 'ok';
    }
    if (this.identity === 'other') {
      this.logger.warn('AirTouch 5: another console answers at this address');
    }
    this.consoleKey = this.identity === 'ok' ? memory.id : undefined;
    await this.saveMemory();
  }

  /** The console id the stops and the commands of a device must match. */
  get ownerId() {
    return this.memoryState === 'ok' ? this.memory.id : this.consoleKey;
  }

  // --- Reads -----------------------------------------------------------------

  scheduleRead(delay) {
    if (this.readTimer) {
      this.timers.clearTimeout(this.readTimer);
      this.readTimer = undefined;
    }
    if (this.closed || !this.config?.address) return;
    const wait = Math.max(0, delay);
    const generation = this.generation;
    this.nextReadAt = this.monotonic() + wait;
    this.readTimer = this.timers.setTimeout(() => {
      this.readTimer = undefined;
      if (generation === this.generation) {
        this.tick().catch((err) => this.logger.error(`AirTouch 5 read failed: ${err.message}`));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    if (!this.running) {
      this.running = this.read().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async read() {
    const generation = this.generation;
    if (this.readTimer) {
      this.timers.clearTimeout(this.readTimer);
      this.readTimer = undefined;
    }
    const mono = this.monotonic();
    this.nextReadAt = mono + this.interval;
    // The attempt is kept in /data before the read (at most once a minute).
    this.lastAttemptWall = this.now();
    if (this.memoryState === 'unreadable') {
      await this.loadMemory();
    }
    if (this.attemptSavedAt === undefined || mono - this.attemptSavedAt >= TIMINGS.attemptSave) {
      this.attemptSavedAt = mono;
      this.memory.attemptAt = this.lastAttemptWall;
      await this.saveMemory();
    }
    if (generation !== this.generation) return;
    let failed;
    const used = { session: undefined };
    try {
      await this.readRound(generation, used);
    } catch (err) {
      failed = err;
    }
    if (generation !== this.generation || this.closed) return;
    if (failed && used.session?.cutByStop) {
      // Cut by a stop: not a failure of the console; the next read at the interval.
      failed = undefined;
    } else if (failed) {
      this.failed(failed, used.session);
    } else {
      this.online = true;
      this.failures = 0;
      this.reason = undefined;
      if (['unverified', 'other', 'unsaved'].includes(this.identity)) {
        const session = this.session;
        if (session) this.checkIdentity(session).catch(() => {});
      }
    }
    await this.publishAll();
    if (generation === this.generation) {
      const wait = failed
        ? Math.max(
            this.interval,
            TIMINGS.backoff[Math.min(this.failures - 1, TIMINGS.backoff.length - 1)],
          )
        : this.interval;
      this.scheduleRead(wait - (this.monotonic() - mono));
    }
  }

  async readRound(generation, used) {
    const ask = async (build, kind) => {
      const { session } = await this.exchange(PRIORITY.READ, build, {
        kind,
        // A read waits for the stops and commands ahead of it.
        waitBy: this.monotonic() + TIMINGS.connectTimeout + TIMINGS.requestTimeout,
        timeoutMs: TIMINGS.requestTimeout,
      });
      if (session !== used.session) throw new SessionError(ERROR_KINDS.CLOSED, 'session changed');
    };
    const mono = this.monotonic();
    used.session = await this.ensureSession({ deadline: mono + TIMINGS.connectTimeout + SECOND });
    if (generation !== this.generation) return;
    if (this.layoutAt === undefined || mono - this.layoutAt >= TIMINGS.layoutRefresh) {
      await ask(acAbilityRequest, KIND.AC_ABILITY);
      // Secondary: names and version never stop the read.
      for (const [build, kind] of [
        [zoneNameRequest, KIND.ZONE_NAME],
        [versionRequest, KIND.VERSION],
      ]) {
        try {
          await ask(build, kind);
        } catch (err) {
          if (err.kind === ERROR_KINDS.CLOSED) throw err;
          this.logger.info(`AirTouch 5: ${kind} not read (${errorReason(err)})`);
        }
      }
      this.layoutAt = mono;
    }
    await ask(acStatusRequest, KIND.AC_STATUS);
    await ask(zoneStatusRequest, KIND.ZONE_STATUS);
  }

  failed(err, session) {
    this.failures += 1;
    this.online = false;
    this.reason = errorReason(err);
    // Only the session of this read: never one a stop opened meanwhile.
    if (session && this.session === session) session.close('read failed');
    this.logger.warn(`AirTouch 5: ${this.reason}`);
  }

  /** Reads 5 s and 20 s after a command or a stop not confirmed, on the open session only. */
  scheduleFollowUps() {
    if (this.followUps.size > 0) return;
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const timer = this.timers.setTimeout(() => {
        this.followUps.delete(timer);
        if (generation !== this.generation || !this.session || this.closed) return;
        const waitBy = this.monotonic() + TIMINGS.requestTimeout + SECOND;
        for (const [build, kind] of [
          [acStatusRequest, KIND.AC_STATUS],
          [zoneStatusRequest, KIND.ZONE_STATUS],
        ]) {
          this.exchange(PRIORITY.READ, build, {
            kind,
            waitBy,
            timeoutMs: TIMINGS.requestTimeout,
          }).catch(() => {});
        }
      }, delay);
      this.followUps.add(timer);
    }
  }

  // --- Frames ----------------------------------------------------------------

  /** Every frame of the session, asked or pushed, in the order the console sent them. */
  onFrame(session, parsed) {
    if (this.session !== session) return;
    this.frameSeq += 1;
    const seq = this.frameSeq;
    const at = this.monotonic();
    switch (parsed.kind) {
      case KIND.AC_STATUS:
        for (const state of parsed.value) {
          this.acs.set(state.ac, { state, seq, at });
          this.observe({ kind: KINDS.AC, number: state.ac }, state, seq);
        }
        break;
      case KIND.ZONE_STATUS:
        for (const state of parsed.value) {
          this.zones.set(state.zone, { state, seq, at });
          this.observe({ kind: KINDS.ZONE, number: state.zone }, state, seq);
        }
        break;
      case KIND.AC_ABILITY:
        this.abilities = new Map(parsed.value.map((a) => [a.ac, a]));
        break;
      case KIND.ZONE_NAME:
        this.names = parsed.value;
        break;
      case KIND.VERSION:
        this.version = parsed.value.version;
        break;
      default:
        return;
    }
    if (parsed.kind === KIND.AC_STATUS || parsed.kind === KIND.ZONE_STATUS) {
      this.queueStates(parsed.kind, parsed.value);
      this.flush().catch(() => {});
    }
  }

  /** A status of a target, through its guards (stop and commands). */
  observe(target, state, seq) {
    const key = targetKey(target);
    const guard = this.guardFor(key);
    if (guard && guard.sent && seq > guard.afterSeq && typeof state.on === 'boolean') {
      if (!state.on) {
        guard.other = 0;
        if (!guard.confirmed) {
          guard.confirmed = true;
          guard.due = false;
          this.answerStop(guard, true);
          this.saveLater();
          this.lastStatus = undefined;
        }
      } else if (guard.confirmed) {
        // Switched on elsewhere: read twice in a row, the stop is over.
        guard.other += 1;
        if (guard.other >= 2) {
          this.liftGuard(guard);
        }
      } else if (!guard.due && guard.resends < STOP_RESENDS && !guard.writing) {
        // Contradicted before it was seen applied: sent again (counted when written).
        guard.due = true;
        this.kickStops();
      }
    }
    // The guards of the other commands: never lifted on an unknown value.
    for (const [gkey, cg] of [...this.commandGuards]) {
      if (!gkey.startsWith(`${key}:`)) continue;
      if (this.monotonic() >= cg.until) {
        this.commandGuards.delete(gkey);
        continue;
      }
      const value = state[gkey.slice(key.length + 1)];
      if (value === undefined) continue;
      if (!same(value, cg.from)) cg.moved = true;
      if (same(value, cg.expected) && (cg.moved || same(cg.from, cg.expected))) {
        this.commandGuards.delete(gkey);
      }
    }
  }

  /** The stop guard of a target of the console of this address (or of an unknown one). */
  guardFor(key) {
    const owner = this.ownerId;
    if (owner !== undefined) return this.guards.get(`${owner}:${key}`);
    return [...this.guards.values()].find((g) => g.target === key);
  }

  liftGuard(guard) {
    const key = `${guard.id}:${guard.target}`;
    if (this.guards.get(key) === guard) {
      this.guards.delete(key);
      this.answerStop(guard, true);
      this.lastStatus = undefined;
      this.saveLater();
    }
  }

  // --- Gladys ----------------------------------------------------------------

  live() {
    return Boolean(
      this.config &&
      this.session &&
      !this.session.closed &&
      this.identity === 'ok' &&
      this.consoleKey,
    );
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  createdDevice(externalId) {
    return (this.gladys.devices ?? []).find((d) => d?.external_id === externalId);
  }

  /** The AC a zone belongs to (from the abilities), else undefined. */
  acOfZone(zone) {
    for (const ability of this.abilities.values()) {
      if (zone >= ability.startZone && zone < ability.startZone + ability.zoneCount) {
        return ability.ac;
      }
    }
    return undefined;
  }

  /** The setpoint range of a zone: the one of its AC (the frame when unknown). */
  zoneRange(zone) {
    return boundsOf(this.abilities.get(this.acOfZone(zone)));
  }

  buildDevices() {
    // Never a partial list: it would replace the options of the created devices.
    if (!this.live() || this.layoutAt === undefined || this.zones.size + this.acs.size === 0) {
      return [];
    }
    const language = this.config?.language ?? 'fr';
    const devices = [];
    for (const number of [...this.abilities.keys()].sort((a, b) => a - b)) {
      const ids = deviceIds(this.gladys, this.consoleKey, KINDS.AC, number);
      devices.push(
        buildAc(
          this.gladys,
          {
            consoleKey: this.consoleKey,
            ability: this.abilities.get(number),
            number,
            version: this.version,
          },
          { language, created: this.createdDevice(ids.device) },
        ),
      );
    }
    for (const number of [...this.zones.keys()].sort((a, b) => a - b)) {
      const ids = deviceIds(this.gladys, this.consoleKey, KINDS.ZONE, number);
      const { state } = this.zones.get(number);
      devices.push(
        buildZone(
          this.gladys,
          {
            consoleKey: this.consoleKey,
            number,
            name: this.names.get(number),
            hasSensor: state.hasSensor,
            range: this.zoneRange(number),
            ac: this.acOfZone(number),
          },
          { language, created: this.createdDevice(ids.device) },
        ),
      );
    }
    return devices;
  }

  async publishDevices() {
    const devices = this.buildDevices();
    if (devices.length === 0) return;
    const json = JSON.stringify(devices);
    if (json === this.published) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** The states of a status just read (only when the identity is checked). */
  queueStates(kind, list, created = this.createdFeatures()) {
    if (!this.live()) return;
    for (const state of list) {
      const isAc = kind === KIND.AC_STATUS;
      const number = isAc ? state.ac : state.zone;
      const ids = deviceIds(this.gladys, this.consoleKey, isAc ? KINDS.AC : KINDS.ZONE, number);
      for (const { device_feature_external_id: id, ...value } of isAc
        ? acStates(ids, state)
        : zoneStates(ids, state)) {
        if (created.has(id)) this.publisher.push(id, value);
      }
    }
  }

  /** The states read within the freshness window, again (a device created): never older ones. */
  queueFreshStates(created) {
    const mono = this.monotonic();
    const fresh = (map) =>
      [...map.values()].filter((e) => mono - e.at <= TIMINGS.stateFresh).map((e) => e.state);
    this.queueStates(KIND.AC_STATUS, fresh(this.acs), created);
    this.queueStates(KIND.ZONE_STATUS, fresh(this.zones), created);
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishAll() {
    if (this.closed) return;
    await this.publishDevices();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async publishBadge() {
    if (this.closed || this.online === undefined) return;
    const entries = [];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseExternalId(device?.external_id);
      if (!parsed || parsed.key !== undefined) continue;
      const listed =
        parsed.kind === KINDS.AC ? this.acs.has(parsed.number) : this.zones.has(parsed.number);
      const local = this.live() && parsed.console === this.consoleKey && listed;
      entries.push({
        external_id: device.external_id,
        transport: local ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) return;
    try {
      await this.gladys.publishTransports(entries.slice(0, 100));
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  async updateStatus() {
    if (this.closed) return;
    const [connected, message] = this.statusText();
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The stops as the status tells them: kept unsent, sent unconfirmed, contradicted. */
  stopNotes() {
    const waiting = [];
    const unconfirmed = [];
    const contradicted = [];
    for (const guard of this.guards.values()) {
      const target = parseTarget(guard.target);
      if (!target || guard.confirmed) continue;
      if (!guard.sent) waiting.push(targetName(target));
      else if (guard.resends >= STOP_RESENDS && !guard.due) contradicted.push(targetName(target));
      else unconfirmed.push(targetName(target));
    }
    const notes = [];
    if (waiting.length) notes.push(T.stopsWaiting(waiting));
    if (unconfirmed.length) notes.push(T.stopsUnconfirmed(unconfirmed));
    if (contradicted.length) notes.push(T.stopsContradicted(contradicted));
    return notes;
  }

  statusText() {
    const notes = [];
    if (this.memoryState === 'unreadable') notes.push(T.dataUnreadable);
    else if (!this.writable) notes.push(T.dataUnwritable);
    notes.push(...this.stopNotes());
    if (!this.config) {
      const wait = this.configAt === undefined ? SECOND : this.configAt - this.monotonic();
      return [false, join(T.configUnread(age(Math.max(SECOND, wait))), ...notes)];
    }
    if (this.config.invalid) {
      return [false, join(T.invalid, ...notes)];
    }
    if (!this.config.address) {
      return [false, join(T.noAddress, ...notes)];
    }
    if (this.online === false || (!this.session && this.online === undefined && this.reason)) {
      const wait = Math.max(SECOND, (this.nextReadAt ?? this.monotonic()) - this.monotonic());
      return [false, join(T.unreachable(this.reason ?? 'error', age(wait)), ...notes)];
    }
    if (!this.session || this.online === undefined) {
      return [false, join(T.connecting, ...notes)];
    }
    if (this.identity === 'pending' || this.identity === 'none') {
      return [false, join(T.identityPending, ...notes)];
    }
    if (this.identity === 'other') return [false, join(T.otherConsole, ...notes)];
    if (this.identity === 'unsaved') return [false, join(T.identityUnsaved, ...notes)];
    if (this.identity === 'unverified') return [false, join(T.unverified, ...notes)];
    return [true, join(T.connected(this.acs.size, this.zones.size), ...notes)];
  }

  /** A device was created (or updated): its states read lately, at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) created.add(f.external_id);
    this.queueFreshStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab: the devices of the last reads, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  async testConnection() {
    if (!this.config?.address) {
      return this.statusText()[1];
    }
    const mono = this.monotonic();
    if (mono - this.lastTestAt < TIMINGS.testCooldown) {
      return join(T.test.cooldown, this.statusText()[1]);
    }
    this.lastTestAt = mono;
    // Read now only when the read is due: never sooner than the interval.
    if (!this.running && this.nextReadAt !== undefined && this.nextReadAt > mono) {
      return join(this.statusText()[1], T.test.waiting(age(this.nextReadAt - mono)));
    }
    await bounded(this.tick(), TIMINGS.testAnswerBy, this.timers, undefined);
    return this.statusText()[1];
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    return new Error(word(text, this.config?.language ?? 'fr'));
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const parsed = parseExternalId(feature?.external_id);
    if (!parsed || parsed.key === undefined) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (parsed.key === FEATURES.TEMPERATURE) {
      throw this.refusal(ERRORS.readOnly);
    }
    const change = commandValue(parsed.kind, parsed.key, value);
    if (!change) {
      throw this.refusal(ERRORS.badValue);
    }
    const target = { kind: parsed.kind, number: parsed.number };
    if (change.field === 'on' && change.value === false) {
      return this.stopClicked(parsed.console, target, received);
    }
    if (!this.config) {
      this.readConfig().catch(() => {});
      throw this.refusal(ERRORS.configUnread);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (parsed.console !== this.ownerId) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (!this.session || this.session.closed) {
      throw this.refusal(ERRORS.notConnected);
    }
    if (this.identity === 'other') throw this.refusal(ERRORS.otherConsole);
    if (this.identity !== 'ok') throw this.refusal(ERRORS.identity);
    const key = targetKey(target);
    if (this.stopsInFlight.has(key)) {
      throw this.refusal(ERRORS.stopping);
    }
    const guard = this.guardFor(key);
    if (target.kind === KINDS.ZONE && change.field !== 'on' && guard && !guard.confirmed) {
      // A zone being stopped: a value that might open it again waits for the stop.
      throw this.refusal(ERRORS.stopping);
    }
    if (this.waitingCommands >= LIMITS.queue) {
      throw this.refusal(ERRORS.queueFull);
    }
    // One command at a time per target, in order of arrival.
    const entry = { cancelled: false };
    const list = this.commands.get(key) ?? new Set();
    list.add(entry);
    this.commands.set(key, list);
    this.waitingCommands += 1;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.command(target, change, { received, entry }));
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    try {
      return await run;
    } finally {
      list.delete(entry);
      if (list.size === 0) this.commands.delete(key);
      this.waitingCommands -= 1;
      if (this.chains.get(key) === tail) this.chains.delete(key);
    }
  }

  /** The checks right before the write, on the latest configuration. */
  beforeSend(entry, sendBy) {
    if (!this.config?.allowCommands) throw this.refusal(ERRORS.disabled);
    if (entry.cancelled) throw this.refusal(ERRORS.cancelled);
    if (this.identity !== 'ok') throw this.refusal(ERRORS.identity);
    if (this.monotonic() > sendBy) throw this.refusal(ERRORS.tooSlow);
  }

  async command(target, change, { received, entry }) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const key = targetKey(target);
    if (entry.cancelled) throw this.refusal(ERRORS.cancelled);
    if (this.monotonic() > sendBy - 500) throw this.refusal(ERRORS.tooSlow);
    // /data must take a stop: a command is refused when it cannot be written
    // (the wait for it bounded by the deadline of the command).
    const saved = await this.saveMemory({ waitMs: sendBy - 500 - this.monotonic() });
    if (!saved) throw this.refusal(ERRORS.dataUnwritable);
    if (entry.cancelled) throw this.refusal(ERRORS.cancelled);
    const isAc = target.kind === KINDS.AC;
    const statusKind = isAc ? KIND.AC_STATUS : KIND.ZONE_STATUS;
    const statusRequest = isAc ? acStatusRequest : zoneStatusRequest;
    const find = (list) => list.find((s) => (isAc ? s.ac : s.zone) === target.number);
    // The state read just before: the decision is made on it only.
    let state;
    try {
      const { value } = await this.exchange(PRIORITY.COMMAND, statusRequest, {
        kind: statusKind,
        waitBy: sendBy,
        answerBy: sendBy,
      });
      state = find(value);
    } catch (err) {
      if (err instanceof LaneTimeout || err.kind === ERROR_KINDS.LATE)
        throw this.refusal(ERRORS.tooSlow);
      if (err.kind === ERROR_KINDS.CLOSED && !err.sent) throw this.refusal(ERRORS.notConnected);
      throw this.refusal(ERRORS.unknownState);
    }
    if (!state) throw this.refusal(ERRORS.notListed);
    const ability = isAc ? this.abilities.get(target.number) : undefined;
    const wanted = this.wanted(target, change, state, ability);
    const field = change.field;
    if (state[field] === undefined) throw this.refusal(ERRORS.unknownState);
    const guardKey = `${key}:${field}`;
    this.checkPrevious(key, field, state);
    if (same(state[field], wanted.value) && !this.guardActive(guardKey)) {
      // Already so: nothing sent.
      return;
    }
    const build = (id) =>
      isAc ? acControl(id, [wanted.control]) : zoneControl(id, [wanted.control]);
    const plan = { from: state[field], expected: wanted.value };
    let written = false;
    this.logger.info(`AirTouch 5: ${key} ${field} -> ${String(wanted.value)}`);
    let answer;
    try {
      answer = await this.exchange(PRIORITY.COMMAND, build, {
        kind: statusKind,
        waitBy: sendBy,
        answerBy,
        beforeSend: () => this.beforeSend(entry, sendBy),
        onWritten: () => {
          written = true;
          if (field === 'on' && wanted.value === true) {
            // A newer command of the target that left: the stop guard is over.
            const guard = this.guardFor(key);
            if (guard) this.liftGuard(guard);
          }
        },
      });
    } catch (err) {
      if (err.beforeSend) throw err;
      if (!written) {
        if (err instanceof LaneTimeout || err.kind === ERROR_KINDS.LATE)
          throw this.refusal(ERRORS.tooSlow);
        throw this.refusal(ERRORS.notConnected);
      }
      // Written, no answer: it may have been applied.
      this.guardCommand(guardKey, plan);
      this.scheduleFollowUps();
      throw this.refusal(ERRORS.sentUnconfirmed);
    }
    // Confirmed only by a status showing the value asked, never one equal to the state before.
    const applied = (s) => s && same(s[field], wanted.value) && !same(plan.from, wanted.value);
    if (applied(find(answer.value))) {
      this.commandGuards.delete(guardKey);
      return;
    }
    // The answer does not show it yet: one read back within the budget.
    try {
      const { value } = await this.exchange(PRIORITY.COMMAND, statusRequest, {
        kind: statusKind,
        waitBy: answerBy,
        answerBy,
      });
      if (applied(find(value))) {
        this.commandGuards.delete(guardKey);
        return;
      }
    } catch {
      // "sent, without confirmation" below
    }
    this.guardCommand(guardKey, plan);
    this.scheduleFollowUps();
    throw this.refusal(ERRORS.sentUnconfirmed);
  }

  /**
   * What a change writes, checked against the state read just before and the
   * abilities read on this session: `{ value, control }`.
   */
  wanted(target, change, state, ability) {
    const isAc = target.kind === KINDS.AC;
    switch (change.field) {
      case 'on':
        return {
          value: true,
          control: isAc
            ? { ac: target.number, power: AC_POWER.ON }
            : { zone: target.number, power: ZONE_POWER.ON },
        };
      case 'mode': {
        if (!ability || !modesOf(ability).includes(change.value))
          throw this.refusal(ERRORS.notSupported);
        return {
          value: change.value,
          control: { ac: target.number, mode: modeCode(change.value) },
        };
      }
      case 'fan': {
        if (!fansOf(ability).includes(change.value)) throw this.refusal(ERRORS.notSupported);
        return {
          value: change.value,
          control: { ac: target.number, fan: fanCode(ability, change.value) },
        };
      }
      case 'setpoint': {
        if (!isAc && !state.hasSensor) throw this.refusal(ERRORS.noSensor);
        // The limits read on the console on this session: never the frame alone.
        const limits = isAc
          ? ability?.limits
          : this.abilities.get(this.acOfZone(target.number))?.limits;
        const range = setpointRange(limits);
        if (!range) throw this.refusal(ERRORS.limitsUnknown);
        if (!(change.asked >= range.min && change.asked <= range.max)) {
          throw this.refusal(ERRORS.outOfRange(range.min, range.max));
        }
        return {
          value: change.value,
          control: isAc
            ? { ac: target.number, setpoint: change.value }
            : { zone: target.number, setpoint: change.value },
        };
      }
      case 'percent':
        return { value: change.value, control: { zone: target.number, percent: change.value } };
      default:
        throw this.refusal(ERRORS.badValue);
    }
  }

  guardCommand(key, { from, expected }) {
    this.commandGuards.set(key, {
      from,
      expected,
      moved: false,
      until: this.monotonic() + TIMINGS.guard,
    });
  }

  guardActive(key) {
    const guard = this.commandGuards.get(key);
    if (guard && this.monotonic() >= guard.until) {
      this.commandGuards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /** A previous command on another field of the target, not visible yet: refused. */
  checkPrevious(key, field, state) {
    for (const [gkey, guard] of this.commandGuards) {
      if (!gkey.startsWith(`${key}:`)) continue;
      const other = gkey.slice(key.length + 1);
      if (
        other !== field &&
        this.guardActive(gkey) &&
        !guard.moved &&
        same(state[other], guard.from) &&
        !same(state[other], guard.expected)
      ) {
        throw this.refusal(ERRORS.previousPending);
      }
    }
  }

  // --- Stops -----------------------------------------------------------------

  /** The stops to send now: of the console of this address (or of an unknown one). */
  dueGuards() {
    const owner = this.ownerId;
    return [...this.guards.values()].filter(
      (g) => g.due && (owner === undefined || g.id === owner),
    );
  }

  /**
   * A stop clicked: kept at once (saved in the background), the commands of
   * the target still waiting cancelled, sent first. Resolves when a status
   * shows it; rejects "sent, without confirmation" or "kept, not sent" at
   * the deadline (the stop stays kept either way).
   */
  stopClicked(consoleKey, target, received) {
    const owner = this.ownerId;
    if (owner !== undefined && consoleKey !== owner) {
      // The device of another console than the one of this address.
      return Promise.reject(this.refusal(ERRORS.unknownDevice));
    }
    const key = targetKey(target);
    for (const entry of this.commands.get(key) ?? []) entry.cancelled = true;
    this.commandGuards.delete(`${key}:on`);
    const id = owner ?? consoleKey;
    const gkey = `${id}:${key}`;
    const previous = this.guards.get(gkey);
    const guard = {
      id,
      target: key,
      sent: false,
      confirmed: false,
      resends: 0,
      other: 0,
      afterSeq: Infinity,
      due: true,
      writing: false,
      waiters: previous?.waiters ?? [],
    };
    this.guards.set(gkey, guard);
    this.lastStatus = undefined;
    this.saveLater();
    this.stopsInFlight.set(key, (this.stopsInFlight.get(key) ?? 0) + 1);
    const done = () => {
      const left = (this.stopsInFlight.get(key) ?? 1) - 1;
      if (left > 0) this.stopsInFlight.set(key, left);
      else this.stopsInFlight.delete(key);
    };
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        sendBy: received + TIMINGS.commandSendBy,
        timer: undefined,
      };
      waiter.timer = this.timers.setTimeout(
        () => {
          const at = guard.waiters.indexOf(waiter);
          if (at < 0) return;
          guard.waiters.splice(at, 1);
          if (guard.sent) {
            this.scheduleFollowUps();
            reject(this.refusal(ERRORS.stopUnconfirmed));
          } else {
            reject(this.refusal(ERRORS.stopKept));
          }
        },
        Math.max(0, received + TIMINGS.commandAnswerBy - this.monotonic()),
      );
      guard.waiters.push(waiter);
      this.kickStops();
      this.updateStatus().catch(() => {});
    }).finally(done);
  }

  /** The clicks of a stop answered: confirmed (or lifted). */
  answerStop(guard, ok) {
    for (const waiter of guard.waiters.splice(0)) {
      this.timers.clearTimeout(waiter.timer);
      if (ok) waiter.resolve();
    }
  }

  /** Runs the stop lane (one runner); a no-op while it runs (it takes the new stops). */
  kickStops() {
    if (this.closed || this.stopRunner) return;
    this.stopRunner = this.runStops()
      .catch((err) => this.logger.error(`AirTouch 5 stops failed: ${err.message}`))
      .finally(() => {
        this.stopRunner = undefined;
        if (!this.closed && this.dueGuards().length > 0 && !this.stopRetry.timer) {
          this.scheduleStopRetry();
        }
      });
  }

  scheduleStopRetry() {
    const delays = [10 * SECOND, 30 * SECOND, 60 * SECOND];
    const delay = delays[Math.min(this.stopRetry.tries, delays.length - 1)];
    this.stopRetry.tries += 1;
    this.stopRetry.timer = this.timers.setTimeout(() => {
      this.stopRetry.timer = undefined;
      this.kickStops();
    }, delay);
  }

  async runStops() {
    const startedAt = this.monotonic();
    for (let round = 0; round < 50 && !this.closed; round += 1) {
      const due = this.dueGuards();
      if (due.length === 0) return;
      const sent = await this.sendStops(due);
      if (sent) {
        this.stopRetry.tries = 0;
        if (this.stopRetry.timer) {
          this.timers.clearTimeout(this.stopRetry.timer);
          this.stopRetry.timer = undefined;
        }
        continue;
      }
      // Not sent: tried again within 250 ms, then kept for the retry timer.
      if (this.monotonic() - startedAt >= TIMINGS.stopRetry) return;
      await new Promise((resolve) => this.timers.setTimeout(resolve, 50));
    }
  }

  /** One write of the stops due (ACs in one frame, then zones): true when one left. */
  async sendStops(due) {
    const cut = this.watchStall();
    let release;
    try {
      release = await this.lane.acquire(PRIORITY.STOP);
    } finally {
      cut();
    }
    let any = false;
    try {
      let session;
      try {
        session = await this.ensureSession({ deadline: this.monotonic() + TIMINGS.connectTimeout });
      } catch (err) {
        this.reason = errorReason(err);
        this.lastStatus = undefined;
        this.updateStatus().catch(() => {});
        return false;
      }
      for (const kind of [KINDS.AC, KINDS.ZONE]) {
        if (!due.some((g) => parseTarget(g.target)?.kind === kind)) continue;
        let batch = [];
        const isAc = kind === KINDS.AC;
        try {
          await session.request(
            (id) =>
              isAc
                ? acControl(
                    id,
                    batch.map((g) => ({ ac: parseTarget(g.target).number, power: AC_POWER.OFF })),
                  )
                : zoneControl(
                    id,
                    batch.map((g) => ({
                      zone: parseTarget(g.target).number,
                      power: ZONE_POWER.OFF,
                    })),
                  ),
            {
              kind: isAc ? KIND.AC_STATUS : KIND.ZONE_STATUS,
              // A short wait: the next stops never wait long behind this one
              // (a status read later, a push or a follow-up confirms it).
              timeoutMs: TIMINGS.stopAnswer,
              beforeSend: () => {
                // The guards still due right now (a newer click may have lifted one).
                batch = this.dueGuards().filter((g) => parseTarget(g.target)?.kind === kind);
                if (batch.length === 0) throw new Error('nothing to send');
                for (const g of batch) g.writing = true;
              },
              onWritten: () => {
                any = true;
                for (const g of batch) {
                  if (g.sent) g.resends += 1;
                  g.sent = true;
                  g.due = false;
                  g.writing = false;
                  g.afterSeq = this.frameSeq;
                }
                this.logger.info(`AirTouch 5: stop -> ${batch.map((g) => g.target).join(', ')}`);
                this.lastStatus = undefined;
                this.saveLater();
              },
            },
          );
        } catch (err) {
          for (const g of batch) g.writing = false;
          if (err.beforeSend) continue;
          if (err.sent) {
            any = true;
            this.scheduleFollowUps();
          }
          if (err.kind === ERROR_KINDS.TIMEOUT) {
            // Silent console: the next try opens a new session.
            session.close('no answer to a stop');
          }
          if (session.closed) break;
        }
      }
    } finally {
      release();
    }
    if (any) {
      this.updateStatus().catch(() => {});
    }
    return any;
  }

  /**
   * While a stop waits for the lane: a request in flight that received
   * nothing for a second is cut (its session closed). Returns the cancel.
   */
  watchStall() {
    let timer;
    let done = false;
    const check = () => {
      if (done) return;
      const session = this.session;
      if (session && session.busy && this.lane.held) {
        const silent = session.silentFor(this.monotonic());
        if (silent >= TIMINGS.stallCut) {
          // Not a failure of the console: the read it cuts does not count.
          session.cutByStop = true;
          session.close('cut by a stop');
          return;
        }
        timer = this.timers.setTimeout(check, Math.max(10, TIMINGS.stallCut - silent));
        return;
      }
      if (this.lane.held) {
        timer = this.timers.setTimeout(check, 100);
      }
    };
    check();
    return () => {
      done = true;
      this.timers.clearTimeout(timer);
    };
  }
}

/** Equality of two values of a field (setpoints to 0.05 °C). */
function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.05;
  return a === b;
}

export { both };
