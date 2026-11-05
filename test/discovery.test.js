// -----------------------------------------------------------------------------
// The UDP identification: unicast, the answer to the port the document names
// (49005, here a free port of the test), only from the address asked.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { identityOnce, queryIdentity } from '../src/airtouch/discovery.js';

const freePort = async () => {
  const s = dgram.createSocket('udp4');
  await new Promise((resolve) => s.bind(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
};

/**
 * A console on `address`: answers to `replyPort` (the document's behaviour:
 * a fixed port, not the source of the request) or to the source when absent.
 */
async function udpConsole(t, answer, { address = '127.0.0.1', replyPort, from } = {}) {
  const socket = dgram.createSocket('udp4');
  const sender = from ? dgram.createSocket('udp4') : socket;
  if (from) await new Promise((resolve) => sender.bind(0, from, resolve));
  const asked = [];
  socket.on('message', (message, rinfo) => {
    asked.push(message.toString('utf8'));
    const reply = answer(message);
    if (reply) sender.send(Buffer.from(reply), replyPort ?? rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => socket.bind(0, address, resolve));
  t.after(() => {
    socket.close();
    if (from) sender.close();
  });
  return { port: socket.address().port, asked };
}

test('the console answers to the fixed port: the request leaves from it and hears the answer', async (t) => {
  const localPort = await freePort();
  const dev = await udpConsole(t, () => '127.0.0.1,AT5N202502000001,AirTouch5,4300000,Home', {
    replyPort: localPort,
  });
  const ephemeral = [];
  const identity = await identityOnce({
    ip: '127.0.0.1',
    port: dev.port,
    localPort,
    waitMs: 1000,
    onEphemeral: (e) => ephemeral.push(e),
  });
  assert.equal(identity?.consoleId, 'at5n202502000001');
  assert.deepEqual(dev.asked, ['::REQUEST-POLYAIRE-AIRTOUCH-DEVICE-INFO:;']);
  assert.deepEqual(ephemeral, [false]);
});

test('the fixed port taken: a free port, reported (the answer to the fixed port is then lost)', async (t) => {
  const busy = dgram.createSocket('udp4');
  await new Promise((resolve) => busy.bind(0, resolve));
  t.after(() => busy.close());
  const localPort = busy.address().port;
  const dev = await udpConsole(t, () => '127.0.0.1,AT5N202502000001,AirTouch5,4300000,Home');
  const ephemeral = [];
  const identity = await identityOnce({
    ip: '127.0.0.1',
    port: dev.port,
    localPort,
    waitMs: 1000,
    onEphemeral: (e) => ephemeral.push(e),
  });
  // This console answers to the source: heard on the free port.
  assert.equal(identity?.consoleId, 'at5n202502000001');
  assert.deepEqual(ephemeral, [true]);
});

test('an answer from another address, or naming another one, or none: undefined', async (t) => {
  const localPort = await freePort();
  // From 127.0.0.2, claiming to be 127.0.0.1: ignored.
  const spoof = await udpConsole(t, () => '127.0.0.1,AT5N202502000009,AirTouch5,1,X', {
    replyPort: localPort,
    from: '127.0.0.2',
  });
  assert.equal(
    await identityOnce({ ip: '127.0.0.1', port: spoof.port, localPort, waitMs: 200 }),
    undefined,
  );
  const other = await udpConsole(t, () => '10.0.0.9,AT5N202502000001,AirTouch5,4300000,Home', {
    replyPort: localPort,
  });
  assert.equal(
    await queryIdentity({ ip: '127.0.0.1', port: other.port, localPort, tries: 2, waitMs: 100 }),
    undefined,
  );
  assert.equal(other.asked.length, 2);
  const mute = await udpConsole(t, () => undefined);
  assert.equal(
    await identityOnce({ ip: '127.0.0.1', port: mute.port, localPort, waitMs: 50 }),
    undefined,
  );
});
