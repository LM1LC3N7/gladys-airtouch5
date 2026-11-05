// -----------------------------------------------------------------------------
// The identity of the console: the identification request of the AirTouch 5
// in UDP (port 49005), sent in unicast to the address of the session (never
// in broadcast: the container sits on a bridge network, only unicast crosses
// it). The answer "<ip>,<console id>,AirTouch5,<AirTouch id>,<name>" is
// taken only from that address, within its wait; anything else is ignored.
// The socket is closed after each try.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { DISCOVERY_PORT, LIMITS } from '../constants.js';
import { IDENTITY_REQUEST, parseIdentity } from './protocol.js';

/** One try: the identity, or undefined after `waitMs`. */
export function identityOnce({ ip, port = DISCOVERY_PORT, waitMs, timers = globalThis }) {
  return new Promise((resolve) => {
    let socket;
    let timer;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      timers.clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      resolve(value);
    };
    try {
      socket = dgram.createSocket({ type: 'udp4' });
    } catch {
      resolve(undefined);
      return;
    }
    timer = timers.setTimeout(() => finish(undefined), Math.max(0, waitMs));
    socket.on('error', () => finish(undefined));
    socket.on('message', (message, rinfo) => {
      if (rinfo.address !== ip || message.length > LIMITS.datagram) {
        return;
      }
      const identity = parseIdentity(message);
      if (identity && identity.ip === ip) {
        finish(identity);
      }
    });
    socket.send(IDENTITY_REQUEST, port, ip, (err) => {
      if (err) finish(undefined);
    });
  });
}

/** Up to `tries` tries; the identity or undefined. `isCancelled()` stops between tries. */
export async function queryIdentity({
  ip,
  port,
  tries,
  waitMs,
  timers,
  isCancelled = () => false,
}) {
  for (let i = 0; i < tries && !isCancelled(); i += 1) {
    const identity = await identityOnce({ ip, port, waitMs, timers });
    if (identity) {
      return identity;
    }
  }
  return undefined;
}
