// -----------------------------------------------------------------------------
// One TCP session to an AirTouch 5 console (port 9005): connect within a
// deadline, frames read and checked as they come (src/airtouch/protocol.js),
// one request at a time (never two in flight: no pipelining), the answer
// being the first frame of the expected kind read after the request was
// written. Every status the console sends, asked or not, goes to `onFrame`.
//
// Bounded: bytes waiting for the end of a frame (8 KB), bytes read without
// any header (4 KB), frames that fail their CRC or do not parse (8 in a row,
// each dropped, never a value), frames read
// while waiting for one answer (32): past any of them the session is closed.
// A session is never reopened: the app opens a new one, only after this one
// is closed (one connection to the console at a time).
// -----------------------------------------------------------------------------

import net from 'node:net';
import { LIMITS } from '../constants.js';
import { ProtocolError, readFrame, splitFrames } from './protocol.js';

export const ERROR_KINDS = {
  CONNECT: 'connect',
  TIMEOUT: 'timeout',
  CLOSED: 'closed',
  PROTOCOL: 'protocol',
  LATE: 'late',
  BUSY: 'busy',
};

export class SessionError extends Error {
  constructor(kind, message, { sent = false, code } = {}) {
    super(message);
    this.name = 'SessionError';
    this.kind = kind;
    /** Whether bytes of the request were written (it may have been applied). */
    this.sent = sent;
    this.code = code;
  }
}

/** A short reason, never a secret (the protocol has none): for the logs and the statuses. */
export function errorReason(err) {
  if (err?.code === 'ECONNREFUSED') return 'connection refused';
  if (err?.code === 'EHOSTUNREACH' || err?.code === 'ENETUNREACH') return 'host unreachable';
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') return 'name not found';
  switch (err?.kind) {
    case ERROR_KINDS.TIMEOUT:
      return 'no answer';
    case ERROR_KINDS.CLOSED:
      return 'connection closed';
    case ERROR_KINDS.PROTOCOL:
      return 'not an AirTouch 5 answer';
    case ERROR_KINDS.CONNECT:
      return 'connection failed';
    case ERROR_KINDS.LATE:
      return 'too late';
    default:
      return String(err?.message ?? 'error').slice(0, 80);
  }
}

/** Connects to `ip:port` within `timeoutMs`; the socket is destroyed on failure. */
export function tcpConnect({ ip, port, timeoutMs, timers = globalThis }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ip, port, noDelay: true });
    const timer = timers.setTimeout(
      () => {
        socket.destroy();
        reject(new SessionError(ERROR_KINDS.TIMEOUT, 'connect timeout'));
      },
      Math.max(0, timeoutMs),
    );
    socket.once('connect', () => {
      timers.clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (err) => {
      timers.clearTimeout(timer);
      socket.destroy();
      reject(new SessionError(ERROR_KINDS.CONNECT, err.message, { code: err.code }));
    });
  });
}

export class Session {
  /**
   * `socket`: connected. `monotonic`, `timers`: the app's clocks.
   * `onFrame(parsed)`: every frame of a known kind (pushes and answers alike).
   */
  constructor({ socket, monotonic, timers, onFrame = () => {}, onClose = () => {} }) {
    this.socket = socket;
    this.monotonic = monotonic;
    this.timers = timers;
    this.onFrame = onFrame;
    this.buffer = Buffer.alloc(0);
    this.garbage = 0;
    this.badInRow = 0;
    this.closed = false;
    this.lastByteAt = monotonic();
    this.nextId = 1;
    /** The request in flight: { kind, id, writtenAt, resolve, reject, frames, timer }. */
    this.pending = undefined;
    this.whenClosed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => this.close('socket error'));
    socket.on('close', () => {
      this.close('closed by the console');
      this.resolveClosed();
    });
    socket.on('end', () => this.close('closed by the console'));
    this.onClose = onClose;
  }

  get busy() {
    return Boolean(this.pending);
  }

  /** Monotonic ms since the last byte read, or since the request in flight was written. */
  silentFor(mono = this.monotonic()) {
    const since = Math.max(this.lastByteAt, this.pending?.writtenAt ?? -Infinity);
    return mono - since;
  }

  close(reason = 'closed') {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.destroy();
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      this.timers.clearTimeout(pending.timer);
      pending.reject(new SessionError(ERROR_KINDS.CLOSED, reason, { sent: pending.sent }));
    }
    // `whenClosed` resolves once the socket is really closed (its 'close' event).
    this.onClose(reason);
  }

  onData(chunk) {
    if (this.closed) {
      return;
    }
    this.lastByteAt = this.monotonic();
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > LIMITS.buffer + LIMITS.frameData) {
      this.close('answer too large');
      return;
    }
    const { frames, rest, dropped, bad } = splitFrames(this.buffer);
    this.buffer = rest;
    this.garbage = frames.length > 0 ? dropped : this.garbage + dropped;
    this.badInRow += bad;
    if (this.garbage > LIMITS.garbage || this.badInRow >= 8) {
      this.close('not an AirTouch 5 answer');
      return;
    }
    for (const frame of frames) {
      let parsed;
      try {
        parsed = readFrame(frame);
      } catch (err) {
        if (!(err instanceof ProtocolError)) throw err;
        // A frame of a known kind that does not parse: dropped (never a value),
        // the session goes on; too many in a row and it is closed.
        this.badInRow += 1;
        if (this.badInRow >= 8) {
          this.close('not an AirTouch 5 answer');
          return;
        }
        continue;
      }
      this.badInRow = 0;
      if (!parsed) {
        continue;
      }
      const pending = this.pending;
      const answer = pending && pending.written && parsed.kind === pending.kind;
      if (answer) {
        this.pending = undefined;
        this.timers.clearTimeout(pending.timer);
      } else if (pending && pending.written) {
        pending.frames += 1;
        if (pending.frames > LIMITS.framesPerRequest) {
          this.close('no answer among the frames');
          return;
        }
      }
      this.onFrame(parsed, { answer });
      if (this.closed) {
        return;
      }
      if (answer) {
        pending.resolve(parsed.value);
      }
    }
  }

  /**
   * Writes the frame `build(id)` and resolves with the value of the first
   * frame of `kind` read after it. `beforeSend()` runs right before the write
   * (it may throw: nothing is written, the error is passed through);
   * `onWritten()` right after. Rejects a SessionError whose `sent` tells
   * whether the request was written.
   */
  request(build, { kind, timeoutMs, beforeSend, onWritten }) {
    if (this.closed) {
      return Promise.reject(new SessionError(ERROR_KINDS.CLOSED, 'session closed'));
    }
    if (this.pending) {
      return Promise.reject(new SessionError(ERROR_KINDS.BUSY, 'a request is in flight'));
    }
    if (!(timeoutMs > 0)) {
      return Promise.reject(new SessionError(ERROR_KINDS.LATE, 'too late'));
    }
    try {
      beforeSend?.();
    } catch (err) {
      err.beforeSend = true;
      return Promise.reject(err);
    }
    const id = this.nextId;
    this.nextId = (this.nextId % 255) + 1;
    const frame = build(id);
    return new Promise((resolve, reject) => {
      const pending = { kind, id, resolve, reject, frames: 0, written: false, sent: false };
      this.pending = pending;
      pending.timer = this.timers.setTimeout(() => {
        if (this.pending === pending) {
          this.pending = undefined;
          reject(new SessionError(ERROR_KINDS.TIMEOUT, 'no answer', { sent: pending.sent }));
        }
      }, timeoutMs);
      pending.writtenAt = this.monotonic();
      pending.written = true;
      pending.sent = true;
      this.socket.write(frame);
      onWritten?.();
    });
  }
}
