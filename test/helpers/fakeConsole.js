// -----------------------------------------------------------------------------
// A fake AirTouch 5 console on a real local TCP socket (127.0.0.1, free
// port), built from the Polyaire protocol document as airtouch5py encodes it:
// it answers the status, ability, zone name and version requests, applies
// the AC and zone controls (answering with the new status), and can push a
// status by itself. Faults on demand: silent, latency, controls ignored,
// garbage, single client. The frames it writes are encoded here, apart from
// the module (only the CRC and the frame splitting are shared, and those are
// checked against the frames of the document in test/protocol.test.js).
// -----------------------------------------------------------------------------

import net from 'node:net';
import { encodeFrame, splitFrames } from '../../src/airtouch/protocol.js';

const B080 = 0xb080;
const B090 = 0xb090;

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
};

/** C0 status data: sub | 0 | normal 0 | repeat length | count | entries. */
const statusData = (sub, length, entries) =>
  Buffer.concat([
    Buffer.from([sub, 0, 0, 0]),
    u16(entries.length > 0 ? length : 0),
    u16(entries.length),
    ...entries,
  ]);

const temperatureBytes = (t) =>
  t === undefined ? Buffer.from([0x07, 0xff]) : u16(Math.round(t * 10 + 500));

export function acStatusFrame(id, acs, repeat = 10) {
  const entries = acs.map((a) => {
    const e = Buffer.alloc(repeat);
    e[0] = (a.power << 4) | a.ac;
    e[1] = (a.mode << 4) | a.fan;
    e[2] = a.setpoint === undefined ? 0xff : Math.round(a.setpoint * 10 - 100);
    e[3] = 0xc0;
    temperatureBytes(a.temperature).copy(e, 4);
    e.writeUInt16BE(a.error ?? 0, 6);
    e[8] = 0x80;
    return e;
  });
  return encodeFrame(B080, id, 0xc0, statusData(0x23, repeat, entries));
}

export function zoneStatusFrame(id, zones) {
  const entries = zones.map((z) => {
    const e = Buffer.alloc(8);
    e[0] = (z.power << 6) | z.zone;
    e[1] = ((z.control === 'temperature' ? 1 : 0) << 7) | z.percent;
    e[2] = z.setpoint === undefined ? 0xff : Math.round(z.setpoint * 10 - 100);
    e[3] = z.hasSensor ? 0x80 : 0;
    temperatureBytes(z.hasSensor ? z.temperature : undefined).copy(e, 4);
    e[6] = z.lowBattery ? 1 : 0;
    return e;
  });
  return encodeFrame(B080, id, 0xc0, statusData(0x21, 8, entries));
}

export function abilityFrame(id, abilities) {
  const parts = [Buffer.from([0xff, 0x11])];
  for (const a of abilities) {
    const name = Buffer.alloc(16);
    name.write(a.name, 'latin1');
    parts.push(
      Buffer.from([a.ac, 24]),
      name,
      Buffer.from([
        a.startZone,
        a.zoneCount,
        a.modeBits,
        a.fanBits,
        a.limits.minCool,
        a.limits.maxCool,
        a.limits.minHeat,
        a.limits.maxHeat,
      ]),
    );
  }
  return encodeFrame(B090, id, 0x1f, Buffer.concat(parts));
}

export function namesFrame(id, names) {
  const parts = [Buffer.from([0xff, 0x13])];
  for (const [zone, name] of names) {
    const text = Buffer.from(name, 'utf8');
    parts.push(Buffer.from([zone, text.length]), text);
  }
  return encodeFrame(B090, id, 0x1f, Buffer.concat(parts));
}

export function versionFrame(id, version) {
  const text = Buffer.from(version, 'latin1');
  return encodeFrame(
    B090,
    id,
    0x1f,
    Buffer.concat([Buffer.from([0xff, 0x30, 0, text.length]), text]),
  );
}

/** A default system: 2 ACs (AC 0 zones 0-2, AC 1 zones 3-4). */
export const defaultSystem = () => ({
  acs: [
    { ac: 0, power: 1, mode: 4, fan: 2, setpoint: 22, temperature: 23.5 },
    { ac: 1, power: 0, mode: 1, fan: 0, setpoint: 21, temperature: 19 },
  ],
  zones: [
    {
      zone: 0,
      power: 1,
      control: 'temperature',
      percent: 50,
      setpoint: 22,
      hasSensor: true,
      temperature: 23.1,
    },
    {
      zone: 1,
      power: 1,
      control: 'percentage',
      percent: 80,
      setpoint: undefined,
      hasSensor: false,
    },
    { zone: 2, power: 0, control: 'percentage', percent: 0, setpoint: undefined, hasSensor: false },
    {
      zone: 3,
      power: 1,
      control: 'temperature',
      percent: 40,
      setpoint: 21,
      hasSensor: true,
      temperature: 20.4,
    },
    {
      zone: 4,
      power: 0,
      control: 'percentage',
      percent: 30,
      setpoint: undefined,
      hasSensor: false,
    },
  ],
  abilities: [
    {
      ac: 0,
      name: 'Downstairs',
      startZone: 0,
      zoneCount: 3,
      modeBits: 0x1f,
      fanBits: 0x1d,
      limits: { minCool: 16, maxCool: 31, minHeat: 18, maxHeat: 30 },
    },
    {
      ac: 1,
      name: 'Upstairs',
      startZone: 3,
      zoneCount: 2,
      modeBits: 0x13,
      fanBits: 0x1d,
      limits: { minCool: 17, maxCool: 30, minHeat: 17, maxHeat: 28 },
    },
  ],
  names: new Map([
    [0, 'Living'],
    [1, 'Kitchen'],
    [2, 'Bedroom'],
    [3, 'Office'],
    [4, 'Guest'],
  ]),
  version: '1.2.3,1.2.3',
});

export async function fakeConsole(options = {}) {
  const sockets = new Set();
  const dev = {
    ...defaultSystem(),
    port: 0,
    /** Faults: no answer at all; a delay before each answer; controls not applied. */
    silent: false,
    latencyMs: 0,
    applyControls: true,
    /** Kinds of requests left unanswered ('ac-status', 'zone-status', 'ability', 'names', 'version'). */
    ignore: new Set(),
    singleClient: false,
    greet: false,
    acRepeat: 10,
    connections: 0,
    refused: 0,
    open: 0,
    peak: 0,
    /** Every frame received: { at, conn, type, sub, entries }. */
    frames: [],
    ...options,
    count(sub) {
      return this.frames.filter((f) => f.sub === sub).length;
    },
    controls(kind) {
      return this.frames.filter((f) => f.sub === (kind === 'ac' ? 0x22 : 0x20));
    },
    /** Pushes the current status, unasked, to every open connection. */
    push(kind = 'ac') {
      const frame =
        kind === 'ac'
          ? acStatusFrame(0x7e, this.acs, this.acRepeat)
          : zoneStatusFrame(0x7e, this.zones);
      for (const s of sockets) if (!s.destroyed) s.write(frame);
    },
    write(bytes) {
      for (const s of sockets) if (!s.destroyed) s.write(bytes);
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };

  const answer = (frame) => {
    if (frame.type === 0xc0) {
      const sub = frame.data[0];
      const count = frame.data.readUInt16BE(6);
      const entries = [];
      for (let i = 0; i < count; i += 1) entries.push(frame.data.subarray(8 + i * 4, 12 + i * 4));
      return { sub, entries };
    }
    return { sub: frame.data.readUInt16BE(0), entries: [] };
  };

  const reply = (id, sub, entries) => {
    switch (sub) {
      case 0x23:
        return dev.ignore.has('ac-status') ? undefined : acStatusFrame(id, dev.acs, dev.acRepeat);
      case 0x21:
        return dev.ignore.has('zone-status') ? undefined : zoneStatusFrame(id, dev.zones);
      case 0x22:
        if (dev.applyControls) {
          for (const e of entries) {
            const ac = dev.acs.find((a) => a.ac === (e[0] & 0x0f));
            if (!ac) continue;
            const power = e[0] >> 4;
            if (power === 0b0010) ac.power = 0;
            if (power === 0b0011) ac.power = 1;
            if (e[1] >> 4 !== 0x0f) ac.mode = e[1] >> 4;
            if ((e[1] & 0x0f) !== 0x0f) ac.fan = e[1] & 0x0f;
            if (e[2] === 0x40) ac.setpoint = (e[3] + 100) / 10;
          }
        }
        return dev.ignore.has('ac-control') ? undefined : acStatusFrame(id, dev.acs, dev.acRepeat);
      case 0x20:
        if (dev.applyControls) {
          for (const e of entries) {
            const zone = dev.zones.find((z) => z.zone === (e[0] & 0x3f));
            if (!zone) continue;
            const value = e[1] >> 5;
            const power = e[1] & 0x07;
            if (power === 0b010) zone.power = 0;
            if (power === 0b011) zone.power = 1;
            if (value === 0b100) zone.percent = e[2];
            if (value === 0b101) zone.setpoint = (e[2] + 100) / 10;
          }
        }
        return dev.ignore.has('zone-control') ? undefined : zoneStatusFrame(id, dev.zones);
      case 0xff11:
        return dev.ignore.has('ability') ? undefined : abilityFrame(id, dev.abilities);
      case 0xff13:
        return dev.ignore.has('names') ? undefined : namesFrame(id, dev.names);
      case 0xff30:
        return dev.ignore.has('version') ? undefined : versionFrame(id, dev.version);
      default:
        return undefined;
    }
  };

  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    if (dev.singleClient && dev.open >= 1) {
      dev.refused += 1;
      socket.destroy();
      return;
    }
    sockets.add(socket);
    dev.connections += 1;
    dev.open += 1;
    dev.peak = Math.max(dev.peak, dev.open);
    const conn = dev.connections;
    socket.on('close', () => {
      sockets.delete(socket);
      dev.open -= 1;
    });
    // A console that sends its AC status unasked as soon as a client connects.
    if (dev.greet) socket.write(acStatusFrame(0x7d, dev.acs, dev.acRepeat));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = splitFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        const { sub, entries } = answer(frame);
        dev.frames.push({
          at: performance.now(),
          conn,
          type: frame.type,
          sub,
          entries,
          id: frame.id,
        });
        if (dev.silent) continue;
        const out = reply(frame.id, sub, entries);
        if (!out) continue;
        const send = () => !socket.destroyed && socket.write(out);
        if (dev.latencyMs > 0) (dev.timers ?? globalThis).setTimeout(send, dev.latencyMs);
        else send();
      }
    });
  });
  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  dev.port = server.address().port;
  return dev;
}
