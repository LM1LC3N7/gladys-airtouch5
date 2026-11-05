// -----------------------------------------------------------------------------
// The identity of the console: the identification request of the AirTouch 5
// in UDP, sent in unicast to the address of the session (never in broadcast:
// the container sits on a bridge network, only unicast crosses it). The
// Polyaire document (§2.a) says the console answers to port 49005, so the
// request leaves from a socket bound to 49005 (the answer then also comes
// back through the NAT mapping of that port); when 49005 is taken, from a free
// port, which `onEphemeral` reports (a console that follows its document is
// then not heard). The answer "<ip>,<console id>,AirTouch5,<AirTouch id>,
// <name>" is taken only from that address, within its wait; anything else is
// ignored. The socket is closed after each try.
// -----------------------------------------------------------------------------

import dgram from 'node:dgram';
import { DISCOVERY_PORT, LIMITS } from '../constants.js';
import { IDENTITY_REQUEST, parseIdentity } from './protocol.js';

/** Binds `port`, else a free port (`ephemeral: true`); undefined when nothing binds. */
function bind(port) {
  const attempt = (p) =>
    new Promise((resolve) => {
      let socket;
      try {
        socket = dgram.createSocket({ type: 'udp4' });
      } catch {
        resolve(undefined);
        return;
      }
      socket.once('error', () => {
        try {
          socket.close();
        } catch {
          // not bound
        }
        resolve(undefined);
      });
      socket.bind(p, () => {
        socket.removeAllListeners('error');
        resolve(socket);
      });
    });
  return attempt(port).then(async (socket) => {
    if (socket) return { socket, ephemeral: false };
    const other = port === 0 ? undefined : await attempt(0);
    return other ? { socket: other, ephemeral: true } : undefined;
  });
}

/**
 * One try: the identity, or undefined after `waitMs`. `port`: the console's
 * port; `localPort`: the port the request leaves from and the answer comes to.
 */
export function identityOnce({
  ip,
  port = DISCOVERY_PORT,
  localPort = DISCOVERY_PORT,
  waitMs,
  timers = globalThis,
  onEphemeral = () => {},
}) {
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
    timer = timers.setTimeout(() => finish(undefined), Math.max(0, waitMs));
    bind(localPort).then((bound) => {
      if (!bound || done) {
        try {
          bound?.socket.close();
        } catch {
          // already closed
        }
        finish(undefined);
        return;
      }
      socket = bound.socket;
      onEphemeral(bound.ephemeral);
      socket.on('error', () => finish(undefined));
      socket.on('message', (message, rinfo) => {
        // Only from the address asked, never what another host sends to the port.
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
  });
}

/** Up to `tries` tries; the identity or undefined. `isCancelled()` stops between tries. */
export async function queryIdentity({
  ip,
  port,
  localPort,
  tries,
  waitMs,
  timers,
  onEphemeral,
  isCancelled = () => false,
}) {
  for (let i = 0; i < tries && !isCancelled(); i += 1) {
    const identity = await identityOnce({ ip, port, localPort, waitMs, timers, onEphemeral });
    if (identity) {
      return identity;
    }
  }
  return undefined;
}
