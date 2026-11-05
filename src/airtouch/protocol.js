// -----------------------------------------------------------------------------
// The AirTouch 5 binary protocol, pure: frames, CRC, requests, commands and
// the answers, ported from airtouch5py 0.5.1 (Apache-2.0, see
// THIRD_PARTY_NOTICES.md) and checked against the frames of the Polyaire
// protocol document that its tests carry.
//
// Frame: 55 55 55 AA | address (2) | message id (1) | type (1) | data length
// (2) | data | CRC16 Modbus (2, big endian) of everything after the header.
//   type C0 (control / status), address 80 B0 to the console:
//     data = sub type (1) | 0 (1) | normal length (2) | repeat length (2) |
//            repeat count (2) | normal data | repeat data
//     20 zone control, 21 zone status, 22 AC control, 23 AC status
//   type 1F (extended), address 90 B0 to the console:
//     data = FF 11 AC abilities, FF 13 zone names, FF 30 console version.
// Every field read is checked: a frame without its CRC, too long, of a size
// that does not add up, or with a value out of its range is refused, never
// guessed. The redundant 00 the document inserts after three 55 never occurs
// on a real console (airtouch5py): a frame carrying one fails its CRC.
// -----------------------------------------------------------------------------

import { LIMITS, SETPOINT_FRAME } from '../constants.js';

export const HEADER = Buffer.from([0x55, 0x55, 0x55, 0xaa]);
/** Header (4) + address (2) + id (1) + type (1) + length (2) + CRC (2). */
export const MIN_FRAME = 12;

export const ADDRESS = { CONTROL: 0x80b0, EXTENDED: 0x90b0 };
export const TYPE = { CONTROL: 0xc0, EXTENDED: 0x1f };
export const SUB = { ZONE_CONTROL: 0x20, ZONE_STATUS: 0x21, AC_CONTROL: 0x22, AC_STATUS: 0x23 };
export const EXT = { AC_ABILITY: 0xff11, ZONE_NAME: 0xff13, VERSION: 0xff30 };

/** What an answer is, by name (the requests wait for one of these). */
export const KIND = {
  AC_STATUS: 'ac-status',
  ZONE_STATUS: 'zone-status',
  AC_ABILITY: 'ac-ability',
  ZONE_NAME: 'zone-name',
  VERSION: 'version',
};

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** CRC16 Modbus (polynomial 0xA001 reflected, initial 0xFFFF). */
export function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc;
}

/** A whole frame around `data`. */
export function encodeFrame(address, id, type, data) {
  const head = Buffer.alloc(6);
  head.writeUInt16BE(address, 0);
  head.writeUInt8(id & 0xff, 2);
  head.writeUInt8(type, 3);
  head.writeUInt16BE(data.length, 4);
  const body = Buffer.concat([head, data]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16BE(crc16(body), 0);
  return Buffer.concat([HEADER, body, crc]);
}

const control = (sub, repeatLength, entries) => {
  const head = Buffer.alloc(8);
  head.writeUInt8(sub, 0);
  head.writeUInt16BE(entries.length > 0 ? repeatLength : 0, 4);
  head.writeUInt16BE(entries.length, 6);
  return Buffer.concat([head, ...entries]);
};

// --- Requests --------------------------------------------------------------

export const acStatusRequest = (id) =>
  encodeFrame(ADDRESS.CONTROL, id, TYPE.CONTROL, control(SUB.AC_STATUS, 0, []));
export const zoneStatusRequest = (id) =>
  encodeFrame(ADDRESS.CONTROL, id, TYPE.CONTROL, control(SUB.ZONE_STATUS, 0, []));
export const acAbilityRequest = (id) =>
  encodeFrame(ADDRESS.EXTENDED, id, TYPE.EXTENDED, Buffer.from([0xff, 0x11]));
export const zoneNameRequest = (id) =>
  encodeFrame(ADDRESS.EXTENDED, id, TYPE.EXTENDED, Buffer.from([0xff, 0x13]));
export const versionRequest = (id) =>
  encodeFrame(ADDRESS.EXTENDED, id, TYPE.EXTENDED, Buffer.from([0xff, 0x30]));

// --- Commands --------------------------------------------------------------

/** AC control, byte 1 high nibble. */
export const AC_POWER = { KEEP: 0b0000, OFF: 0b0010, ON: 0b0011 };
/** AC mode (control and status): the values of the protocol. */
export const AC_MODE_CODE = { AUTO: 0, HEAT: 1, DRY: 2, FAN: 3, COOL: 4, KEEP: 0b1111 };
/** AC fan speed (control and status). */
export const FAN_CODE = {
  AUTO: 0,
  QUIET: 1,
  LOW: 2,
  MEDIUM: 3,
  HIGH: 4,
  POWERFUL: 5,
  TURBO: 6,
  INTELLIGENT_AUTO: 8,
  KEEP: 0b1111,
};
/** Zone control: byte 2 high bits (value) and low bits (power). */
export const ZONE_VALUE = { KEEP: 0b000, SET_PERCENT: 0b100, SET_SETPOINT: 0b101 };
export const ZONE_POWER = { KEEP: 0b000, OFF: 0b010, ON: 0b011 };

/** The byte of a setpoint: (value * 10) - 100, the value within the frame, to 0.1 °C. */
export function setpointByte(celsius) {
  if (!Number.isFinite(celsius) || celsius < SETPOINT_FRAME.min || celsius > SETPOINT_FRAME.max) {
    throw new ProtocolError(`setpoint out of the frame: ${celsius}`);
  }
  const byte = Math.round(celsius * 10) - 100;
  if (byte < 0 || byte > 0xfe) {
    throw new ProtocolError(`setpoint out of the frame: ${celsius}`);
  }
  return byte;
}

const integerIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/**
 * AC controls, one entry per AC: `[{ ac, power?, mode?, fan?, setpoint? }]`,
 * every missing field kept as it is on the console.
 */
export function acControl(id, list) {
  const entries = (Array.isArray(list) ? list : [list]).map(
    ({ ac, power = AC_POWER.KEEP, mode, fan, setpoint }) => {
      if (!integerIn(ac, 0, LIMITS.acs - 1) || !Object.values(AC_POWER).includes(power)) {
        throw new ProtocolError('bad AC control');
      }
      const modeCode = mode ?? AC_MODE_CODE.KEEP;
      const fanCode = fan ?? FAN_CODE.KEEP;
      if (!integerIn(modeCode, 0, 15) || !integerIn(fanCode, 0, 15)) {
        throw new ProtocolError('bad AC control');
      }
      const entry = Buffer.alloc(4);
      entry.writeUInt8((power << 4) | ac, 0);
      entry.writeUInt8((modeCode << 4) | fanCode, 1);
      if (setpoint === undefined) {
        entry.writeUInt8(0x00, 2);
        entry.writeUInt8(0xff, 3);
      } else {
        entry.writeUInt8(0x40, 2);
        entry.writeUInt8(setpointByte(setpoint), 3);
      }
      return entry;
    },
  );
  if (entries.length === 0 || entries.length > LIMITS.acs) {
    throw new ProtocolError('bad AC control');
  }
  return encodeFrame(ADDRESS.CONTROL, id, TYPE.CONTROL, control(SUB.AC_CONTROL, 4, entries));
}

/** Zone controls, one entry per zone: `[{ zone, power?, percent?, setpoint? }]` (one value at most). */
export function zoneControl(id, list) {
  const entries = (Array.isArray(list) ? list : [list]).map(
    ({ zone, power = ZONE_POWER.KEEP, percent, setpoint }) => {
      if (!integerIn(zone, 0, LIMITS.zones - 1) || !Object.values(ZONE_POWER).includes(power)) {
        throw new ProtocolError('bad zone control');
      }
      if (percent !== undefined && setpoint !== undefined) {
        throw new ProtocolError('bad zone control');
      }
      let value = ZONE_VALUE.KEEP;
      let byte = 0xff;
      if (percent !== undefined) {
        if (!integerIn(percent, 0, 100)) {
          throw new ProtocolError('bad zone percentage');
        }
        value = ZONE_VALUE.SET_PERCENT;
        byte = percent;
      } else if (setpoint !== undefined) {
        value = ZONE_VALUE.SET_SETPOINT;
        byte = setpointByte(setpoint);
      }
      return Buffer.from([zone, (value << 5) | power, byte, 0x00]);
    },
  );
  if (entries.length === 0 || entries.length > LIMITS.zones) {
    throw new ProtocolError('bad zone control');
  }
  return encodeFrame(ADDRESS.CONTROL, id, TYPE.CONTROL, control(SUB.ZONE_CONTROL, 4, entries));
}

// --- Frames read -----------------------------------------------------------

/**
 * Takes the complete frames out of `buffer`: `{ frames, rest, dropped }`.
 * Bytes before a header are dropped (counted); a frame whose length is over
 * the limit or whose CRC is wrong is dropped from its first byte (the next
 * header is searched again), counted in `bad`.
 */
export function splitFrames(buffer) {
  const frames = [];
  let rest = buffer;
  let dropped = 0;
  let bad = 0;
  for (;;) {
    const at = rest.indexOf(HEADER);
    if (at < 0) {
      // Keep the last 3 bytes: the start of a header may be there.
      const keep = Math.min(rest.length, HEADER.length - 1);
      dropped += rest.length - keep;
      rest = rest.subarray(rest.length - keep);
      break;
    }
    dropped += at;
    rest = rest.subarray(at);
    if (rest.length < MIN_FRAME) {
      break;
    }
    const length = rest.readUInt16BE(8);
    if (length > LIMITS.frameData) {
      bad += 1;
      rest = rest.subarray(1);
      continue;
    }
    const total = length + MIN_FRAME;
    if (rest.length < total) {
      break;
    }
    const body = rest.subarray(4, total - 2);
    if (crc16(body) !== rest.readUInt16BE(total - 2)) {
      bad += 1;
      rest = rest.subarray(1);
      continue;
    }
    frames.push({
      address: rest.readUInt16BE(4),
      id: rest[6],
      type: rest[7],
      data: Buffer.from(rest.subarray(10, total - 2)),
    });
    rest = rest.subarray(total);
  }
  return { frames, rest: Buffer.from(rest), dropped, bad };
}

const AC_POWER_READ = { 0: false, 1: true, 2: false, 3: true, 5: true };
const AC_MODE_READ = {
  0: 'auto',
  1: 'heat',
  2: 'dry',
  3: 'fan',
  4: 'cool',
  8: 'auto',
  9: 'auto',
};
const FAN_READ = {
  0: 'auto',
  1: 'quiet',
  2: 'low',
  3: 'medium',
  4: 'high',
  5: 'powerful',
  6: 'turbo',
};

/** A temperature of 11 bits: (value - 500) / 10, over 2000 not available. */
const temperatureOf = (raw) => (raw <= 2000 ? (raw - 500) / 10 : undefined);

function parseControlData(data) {
  if (data.length < 8) {
    throw new ProtocolError('short status');
  }
  const sub = data[0];
  const normal = data.readUInt16BE(2);
  const repeatLength = data.readUInt16BE(4);
  const count = data.readUInt16BE(6);
  if (data.length - 8 !== normal + repeatLength * count) {
    throw new ProtocolError('status length does not add up');
  }
  return { sub, entries: data.subarray(8 + normal), repeatLength, count };
}

/** AC status entries -> [{ ac, on, mode, fan, setpoint, temperature, error }] (unknown = undefined). */
export function parseAcStatus(entries, repeatLength, count) {
  if (count === 0) {
    return [];
  }
  if (repeatLength < 10 || count > LIMITS.acs) {
    throw new ProtocolError('bad AC status');
  }
  const list = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const e = entries.subarray(i * repeatLength, (i + 1) * repeatLength);
    const ac = e[0] & 0x0f;
    if (seen.has(ac)) {
      throw new ProtocolError('AC listed twice');
    }
    seen.add(ac);
    const powerCode = e[0] >> 4;
    const fanCode = e[1] & 0x0f;
    const setpointRaw = e[2];
    const setpoint = setpointRaw === 0xff ? undefined : (setpointRaw + 100) / 10;
    list.push({
      ac,
      on: AC_POWER_READ[powerCode],
      powerCode,
      mode: AC_MODE_READ[e[1] >> 4],
      fan: fanCode >= 8 && fanCode <= 14 ? 'auto' : FAN_READ[fanCode],
      fanCode,
      setpoint:
        setpoint !== undefined && setpoint >= SETPOINT_FRAME.min && setpoint <= SETPOINT_FRAME.max
          ? setpoint
          : undefined,
      temperature: temperatureOf(((e[4] & 0x07) << 8) | e[5]),
      error: e.readUInt16BE(6),
    });
  }
  return list;
}

/** Zone status entries -> [{ zone, on, percent, setpoint, hasSensor, temperature, lowBattery }]. */
export function parseZoneStatus(entries, repeatLength, count) {
  if (count === 0) {
    return [];
  }
  if (repeatLength < 8 || count > LIMITS.zones) {
    throw new ProtocolError('bad zone status');
  }
  const list = [];
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    const e = entries.subarray(i * repeatLength, (i + 1) * repeatLength);
    const zone = e[0] & 0x3f;
    if (seen.has(zone)) {
      throw new ProtocolError('zone listed twice');
    }
    seen.add(zone);
    const power = e[0] >> 6;
    const percent = e[1] & 0x7f;
    const setpointRaw = e[2];
    const setpoint = setpointRaw === 0xff ? undefined : (setpointRaw + 100) / 10;
    const hasSensor = (e[3] & 0x80) !== 0;
    list.push({
      zone,
      // 00 off, 01 on, 11 turbo (on); 10 is not in the document: unknown.
      on: power === 0 ? false : power === 1 || power === 3 ? true : undefined,
      control: (e[1] & 0x80) !== 0 ? 'temperature' : 'percentage',
      percent: percent <= 100 ? percent : undefined,
      setpoint:
        setpoint !== undefined && setpoint >= SETPOINT_FRAME.min && setpoint <= SETPOINT_FRAME.max
          ? setpoint
          : undefined,
      hasSensor,
      temperature: hasSensor ? temperatureOf(((e[4] & 0x07) << 8) | e[5]) : undefined,
      lowBattery: (e[6] & 0x01) !== 0,
    });
  }
  return list;
}

/** Printable text only, trimmed and bounded (names typed on the console). */
export function cleanName(text) {
  const clean = String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffd]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...clean].slice(0, LIMITS.name).join('');
}

/** AC abilities -> [{ ac, name, startZone, zoneCount, modes, fans, limits }]. */
export function parseAbility(bytes) {
  const list = [];
  let rest = bytes;
  const seen = new Set();
  while (rest.length > 2) {
    const ac = rest[0];
    const length = rest[1];
    if (length < 24 || rest.length < 2 + length || ac >= LIMITS.acs || seen.has(ac)) {
      throw new ProtocolError('bad AC ability');
    }
    seen.add(ac);
    const name = cleanName(rest.subarray(2, 18).toString('latin1').split('\u0000')[0]);
    const startZone = rest[18];
    const zoneCount = rest[19];
    const modeBits = rest[20];
    const fanBits = rest[21];
    const limits = {
      minCool: rest[22],
      maxCool: rest[23],
      minHeat: rest[24],
      maxHeat: rest[25],
    };
    list.push({
      ac,
      name,
      startZone,
      zoneCount: startZone + zoneCount <= LIMITS.zones ? zoneCount : 0,
      modes: {
        cool: (modeBits & 0x10) !== 0,
        fan: (modeBits & 0x08) !== 0,
        dry: (modeBits & 0x04) !== 0,
        heat: (modeBits & 0x02) !== 0,
        auto: (modeBits & 0x01) !== 0,
      },
      fans: {
        intelligentAuto: (fanBits & 0x80) !== 0,
        turbo: (fanBits & 0x40) !== 0,
        powerful: (fanBits & 0x20) !== 0,
        high: (fanBits & 0x10) !== 0,
        medium: (fanBits & 0x08) !== 0,
        low: (fanBits & 0x04) !== 0,
        quiet: (fanBits & 0x02) !== 0,
        auto: (fanBits & 0x01) !== 0,
      },
      limits,
    });
    rest = rest.subarray(2 + length);
  }
  return list;
}

/**
 * The setpoint range of an AC, in °C: the intersection of its cooling and
 * heating limits (the reference warns their labels in the document are
 * wrong, so a value is written only if it fits both), within the frame.
 * undefined when the limits are not usable (0, reversed, out of the frame).
 */
export function setpointRange(limits) {
  const { minCool, maxCool, minHeat, maxHeat } = limits ?? {};
  const all = [minCool, maxCool, minHeat, maxHeat];
  if (!all.every((v) => integerIn(v, SETPOINT_FRAME.min, SETPOINT_FRAME.max))) {
    return undefined;
  }
  const min = Math.max(minCool, minHeat);
  const max = Math.min(maxCool, maxHeat);
  return min <= max ? { min, max } : undefined;
}

/** Zone names -> Map(zone -> name). */
export function parseZoneNames(bytes) {
  const names = new Map();
  let rest = bytes;
  while (rest.length > 2) {
    const zone = rest[0];
    const length = rest[1];
    if (rest.length < 2 + length || zone >= LIMITS.zones) {
      throw new ProtocolError('bad zone names');
    }
    names.set(zone, cleanName(rest.subarray(2, 2 + length).toString('utf8')));
    rest = rest.subarray(2 + length);
  }
  return names;
}

/** Console version -> { version, update }. */
export function parseVersion(bytes) {
  if (bytes.length < 2 || bytes.length < 2 + bytes[1]) {
    throw new ProtocolError('bad console version');
  }
  return { update: bytes[0] !== 0, version: cleanName(bytes.subarray(2, 2 + bytes[1])) };
}

/**
 * What a frame from the console is: `{ kind, id, value }`, or undefined for
 * a frame this integration does not use (another type, an echo of a request).
 * Throws ProtocolError on a frame of a known kind that does not parse.
 */
export function readFrame(frame) {
  if (frame.type === TYPE.CONTROL) {
    const { sub, entries, repeatLength, count } = parseControlData(frame.data);
    if (sub === SUB.AC_STATUS) {
      return {
        kind: KIND.AC_STATUS,
        id: frame.id,
        value: parseAcStatus(entries, repeatLength, count),
      };
    }
    if (sub === SUB.ZONE_STATUS) {
      return {
        kind: KIND.ZONE_STATUS,
        id: frame.id,
        value: parseZoneStatus(entries, repeatLength, count),
      };
    }
    return undefined;
  }
  if (frame.type === TYPE.EXTENDED) {
    if (frame.data.length < 2) {
      throw new ProtocolError('short extended frame');
    }
    const sub = frame.data.readUInt16BE(0);
    const rest = frame.data.subarray(2);
    // A request carries 0 or 1 byte: an echo, never an answer.
    if (rest.length <= 1) {
      return undefined;
    }
    if (sub === EXT.AC_ABILITY) {
      return { kind: KIND.AC_ABILITY, id: frame.id, value: parseAbility(rest) };
    }
    if (sub === EXT.ZONE_NAME) {
      return { kind: KIND.ZONE_NAME, id: frame.id, value: parseZoneNames(rest) };
    }
    if (sub === EXT.VERSION) {
      return { kind: KIND.VERSION, id: frame.id, value: parseVersion(rest) };
    }
  }
  return undefined;
}

/**
 * The answer of the console to the UDP identification request:
 * "<ip>,<console id>,AirTouch5,<AirTouch id>,<name>" -> { ip, consoleId,
 * systemId, name }, or undefined when it is not one.
 */
export function parseIdentity(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > LIMITS.datagram) {
    return undefined;
  }
  const parts = bytes.toString('utf8').trim().split(',');
  if (parts.length !== 5 || parts[2] !== 'AirTouch5') {
    return undefined;
  }
  const [ip, consoleId, , systemId, name] = parts;
  if (!/^[A-Za-z0-9]{4,40}$/.test(consoleId) || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    return undefined;
  }
  return {
    ip,
    consoleId: consoleId.toLowerCase(),
    systemId: /^[A-Za-z0-9]{1,40}$/.test(systemId) ? systemId : undefined,
    name: cleanName(name),
  };
}

export const IDENTITY_REQUEST = Buffer.from('::REQUEST-POLYAIRE-AIRTOUCH-DEVICE-INFO:;', 'utf8');
