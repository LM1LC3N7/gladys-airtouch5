// -----------------------------------------------------------------------------
// The TCP session: bounded reads, one request at a time, the answer being the
// first frame of its kind read after the write.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ERROR_KINDS, Session, tcpConnect } from '../src/airtouch/session.js';
import { KIND, acStatusRequest, versionRequest } from '../src/airtouch/protocol.js';
import {
  acStatusFrame,
  defaultSystem,
  versionFrame,
  zoneStatusFrame,
} from './helpers/fakeConsole.js';
import { waitFor } from './helpers/clock.js';

/** A raw server: `onData(chunk, socket)` writes what it wants. */
async function rawServer(t, onData) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('data', (chunk) => onData(chunk, socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

/**
 * A session on the real clock: every wait of these tests ends by itself (a
 * test fails, never hangs, even under a mutant).
 */
async function open(t, port) {
  const frames = [];
  const socket = await tcpConnect({ ip: '127.0.0.1', port, timeoutMs: 2000 });
  const session = new Session({
    socket,
    monotonic: () => performance.now(),
    timers: globalThis,
    onFrame: (parsed, { answer }) => frames.push({ kind: parsed.kind, answer }),
  });
  t.after(() => session.close('test end'));
  return { session, frames };
}

test('the answer is the first frame of its kind after the write; pushes go to onFrame', async (t) => {
  const { acs, zones } = defaultSystem();
  const port = await rawServer(t, (chunk, socket) => {
    // A pushed zone status first, then the answer.
    socket.write(Buffer.concat([zoneStatusFrame(0x7e, zones), acStatusFrame(chunk[6], acs)]));
  });
  const { session, frames } = await open(t, port);
  const value = await session.request(acStatusRequest, { kind: KIND.AC_STATUS, timeoutMs: 1000 });
  assert.equal(value.length, 2);
  assert.deepEqual(frames, [
    { kind: 'zone-status', answer: false },
    { kind: 'ac-status', answer: true },
  ]);
});

test('one request at a time: a second one is refused while the first is in flight', async (t) => {
  const port = await rawServer(t, () => {});
  const { session } = await open(t, port);
  const first = session.request(versionRequest, { kind: KIND.VERSION, timeoutMs: 100 });
  await assert.rejects(
    session.request(versionRequest, { kind: KIND.VERSION, timeoutMs: 1000 }),
    (err) => err.kind === ERROR_KINDS.BUSY && err.sent === false,
  );
  const checked = assert.rejects(
    first,
    (err) => err.kind === ERROR_KINDS.TIMEOUT && err.sent === true,
  );
  await checked;
});

test('beforeSend throwing: nothing written', async (t) => {
  let received = 0;
  const port = await rawServer(t, (chunk) => {
    received += chunk.length;
  });
  const { session } = await open(t, port);
  await assert.rejects(
    session.request(versionRequest, {
      kind: KIND.VERSION,
      timeoutMs: 1000,
      beforeSend: () => {
        throw new Error('option off');
      },
    }),
    (err) => err.beforeSend === true,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(received, 0);
});

test('garbage without a header, or frames failing their CRC: the session is closed', async (t) => {
  const port = await rawServer(t, (chunk, socket) => socket.write(Buffer.alloc(5000, 0x41)));
  const { session } = await open(t, port);
  await assert.rejects(
    session.request(versionRequest, { kind: KIND.VERSION, timeoutMs: 1000 }),
    (err) => err.kind === ERROR_KINDS.CLOSED,
  );
  assert.equal(session.closed, true);

  const bad = versionFrame(1, '1.0');
  bad[bad.length - 1] ^= 0xff;
  const port2 = await rawServer(t, (chunk, socket) => {
    for (let i = 0; i < 8; i += 1) socket.write(bad);
  });
  const two = await open(t, port2);
  await assert.rejects(
    two.session.request(versionRequest, { kind: KIND.VERSION, timeoutMs: 1000 }),
    (err) => err.kind === ERROR_KINDS.CLOSED,
  );
});

test('an announced length over 2 KB is never waited for; a huge stream is cut', async (t) => {
  const port = await rawServer(t, (chunk, socket) => {
    const head = Buffer.from('555555aab08001c0ffff', 'hex');
    socket.write(Buffer.concat([head, Buffer.alloc(20 * 1024, 0x55)]));
  });
  const { session } = await open(t, port);
  await assert.rejects(
    session.request(versionRequest, { kind: KIND.VERSION, timeoutMs: 1000 }),
    (err) => err.kind === ERROR_KINDS.CLOSED,
  );
});

test('too many frames of other kinds while waiting: the session is closed', async (t) => {
  const { zones } = defaultSystem();
  const port = await rawServer(t, (chunk, socket) => {
    for (let i = 0; i < 40; i += 1) socket.write(zoneStatusFrame(0x7e, zones));
  });
  const { session } = await open(t, port);
  await assert.rejects(
    session.request(versionRequest, { kind: KIND.VERSION, timeoutMs: 1000 }),
    (err) => err.kind === ERROR_KINDS.CLOSED,
  );
});

test('a connection refused or silent: an error within the deadline', async (t) => {
  const port = await rawServer(t, () => {});
  await new Promise((resolve) => setTimeout(resolve, 1));
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const free = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(tcpConnect({ ip: '127.0.0.1', port: free, timeoutMs: 2000 }), (err) => {
    return err.kind === ERROR_KINDS.CONNECT && err.code === 'ECONNREFUSED';
  });
  const { session } = await open(t, port);
  session.close('done');
  await waitFor(() => session.closed, 'closed');
});

test('a frame of a known kind that does not parse is dropped, never a value; the session goes on', async (t) => {
  const { acs } = defaultSystem();
  const port = await rawServer(t, (chunk, socket) => {
    // An AC status whose counts do not add up (valid CRC), then the real answer.
    const lie = acStatusFrame(chunk[6], acs);
    lie[17] = 5;
    const fixed = Buffer.from(lie);
    const body = fixed.subarray(4, -2);
    let crc = 0xffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    fixed.writeUInt16BE(crc, fixed.length - 2);
    socket.write(Buffer.concat([fixed, acStatusFrame(chunk[6], acs)]));
  });
  const { session, frames } = await open(t, port);
  const value = await session.request(acStatusRequest, { kind: KIND.AC_STATUS, timeoutMs: 1000 });
  assert.equal(value.length, 2);
  assert.equal(frames.length, 1);
  assert.equal(session.closed, false);
});

test('a request without answer closes the session, unless its kind is asked by no other', async (t) => {
  const port = await rawServer(t, () => {});
  const one = await open(t, port);
  await assert.rejects(
    one.session.request(acStatusRequest, { kind: KIND.AC_STATUS, timeoutMs: 50 }),
    (err) => err.kind === ERROR_KINDS.TIMEOUT,
  );
  assert.equal(one.session.closed, true);
  const two = await open(t, port);
  await assert.rejects(
    two.session.request(versionRequest, {
      kind: KIND.VERSION,
      timeoutMs: 50,
      closeOnTimeout: false,
    }),
    (err) => err.kind === ERROR_KINDS.TIMEOUT,
  );
  assert.equal(two.session.closed, false);
});
