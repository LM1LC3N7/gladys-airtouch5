// -----------------------------------------------------------------------------
// AirTouch 5 constants, manifest keys, limits and timings.
//
// An AirTouch 5 console (Polyaire) drives a ducted air-conditioning system:
// one or more air conditioners (ACs) and their zones (dampers). It serves the
// "AirTouch 5 Communication Protocol" of Polyaire over TCP, port 9005, as
// airtouch5py (Apache-2.0, 0.5.1) and the Home Assistant "airtouch5"
// integration use it: binary frames 55 55 55 AA | address | message id |
// type | length | data | CRC16 (Modbus). Requests: AC status, zone status, AC
// abilities (names, zones, modes, fan speeds, setpoint limits), zone names,
// console version; commands: AC control, zone control. The console answers a
// control with the status of what it controls, and sends a status by itself
// when something changes. It answers in UDP, port 49005, the identification
// request "::REQUEST-POLYAIRE-AIRTOUCH-DEVICE-INFO:;" with
// "<ip>,<console id>,AirTouch5,<AirTouch id>,<name>".
// The protocol has no password: the console must stay on a trusted network.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 9005;
export const DISCOVERY_PORT = 49005;

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  POWER: 'power',
  MODE: 'mode',
  FAN: 'fan-speed',
  SETPOINT: 'target-temperature',
  TEMPERATURE: 'temperature',
  OPENING: 'opening',
};

/** The kinds of devices (the external id part before the number): frozen. */
export const KINDS = { AC: 'ac', ZONE: 'zone' };

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** Gladys core values (server/utils/constants.js; the SDK does not export them). */
export const AC_MODE = { AUTO: 0, COOLING: 1, HEATING: 2, DRYING: 3, FAN: 4 };
export const AC_FAN_SPEED = { AUTO: 0, LOW: 1, MID: 3, HIGH: 5, QUIET: 6, TURBO: 7 };

/**
 * The frame of every setpoint, in °C, whatever the console says: the range
 * the protocol can carry (one byte, (value + 100) / 10, 0xFF = keep). The
 * limits read on the console (AC abilities) narrow it.
 */
export const SETPOINT_FRAME = { min: 10, max: 35 };

export const POLL_INTERVAL = { min: 30, max: 600, default: 60 };

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** The protocol numbers ACs on 4 bits and zones on 6 bits. */
  acs: 16,
  zones: 64,
  /** The data of one frame: 16 zone names of 32 bytes are under 600 bytes. */
  frameData: 2048,
  /** Bytes kept waiting for the end of a frame, and bytes read without any header. */
  buffer: 8 * 1024,
  garbage: 4 * 1024,
  /** Frames read per request before giving up on its answer (pushes in between). */
  framesPerRequest: 32,
  /** A UDP answer of the console (five short fields). */
  datagram: 512,
  /** Names kept (AC names are 16 bytes on the wire). */
  name: 40,
  /** Stops kept in /data. */
  guards: 80,
  /** Waiting commands other than stops. */
  queue: 16,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  connectTimeout: 4 * SECOND,
  /** One request of a read (the reference waits 5 s; the console answers within a few ms). */
  requestTimeout: 3 * SECOND,
  /** A stop cuts a request in flight that has received nothing for this long. */
  stallCut: SECOND,
  /** A stop waits this long for the status that answers it (later reads confirm it too). */
  stopAnswer: 1_500,
  /** The identification request in UDP: tries and wait of each. */
  identityTries: 3,
  identityWait: 1_500,
  /** Failed sessions: 30 s, 1, 2, then 5 minutes, never sooner than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The time of the last attempt is written to /data at most this often. */
  attemptSave: MINUTE,
  /** AC abilities and zone names read again on an open session this often. */
  layoutRefresh: 6 * HOUR,
  /** getConfig() failing: 5 s, 15 s, then every minute, for life. */
  configRetry: [5 * SECOND, 15 * SECOND, MINUTE],
  /** /data: a load or a save that takes longer is unreadable or not written. */
  storeLoad: 2 * SECOND,
  storeSave: 2 * SECOND,
  /** A save never waits longer for the one before it. */
  storeQueue: 3 * SECOND,
  /** The "Test the connection" button: at most this often, answered within 25 s. */
  testCooldown: 10 * SECOND,
  testAnswerBy: 25 * SECOND,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** States older than this are never published again as new (a reconnection, a device created). */
  stateFresh: 2 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): written by 3 s after the click
   * or refused unsent; confirmed by a status that shows them until 3.5 s,
   * after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_000,
  commandAnswerBy: 3_500,
  /** Commands arriving together share one status read and one write (a scene). */
  gather: 20,
  /** A stop that could not leave is tried again for this long, then kept. */
  stopRetry: 250,
  /** Reads after a command or a stop that was not confirmed. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A command (not a stop) not confirmed: "sent, not seen yet" until the state shows it, or 90 s. */
  guard: 90 * SECOND,
};

/** A stop not confirmed is sent again by the reads that contradict it, at most this often. */
export const STOP_RESENDS = 3;
