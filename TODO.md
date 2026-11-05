# TODO

## Decisions

- Version 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag: the first patch release gives 0.1.1.
  The manifest test checks the form and the agreement, never a fixed value.
- Reference: airtouch5py 0.5.1 of 2026-10-30 (Apache-2.0, Dave Leaver; LICENSE
  read in the repository), used by the Home Assistant `airtouch5` integration,
  and the frames of the Polyaire protocol document its tests carry. Logic
  ported to JavaScript, no Python dependency; notice in
  `THIRD_PARTY_NOTICES.md`, copied into the image.
- Neighbour module followed: LM1LC3N7/gladys-coolmasternet (app, publisher,
  config, i18n structure); /data bounded as gladys-ipx800 0.1.3.
- No `keywords` nor `countries` in the manifest (AU, NZ in practice): the store
  does not take them yet. Category `climate` only.
- One console per installation, one TCP session to it at a time (port 9005),
  kept open: the console pushes its status changes on it. A new session opens
  only once the socket of the previous one is closed. One request in flight
  (no pipelining), by priority: stops, commands, reads.
- Reads: AC and zone status every interval (60 s, 30 to 600); AC abilities at
  each session and every 6 h (needed for the setpoint limits, modes, fan
  speeds); zone names and console version are secondary (a failure never stops
  the read). Failed sessions back off 30 s, 1, 2, 5 min, never under the
  interval. The attempt time is written to /data before the read, at most once
  a minute; a restart waits for the rest of the interval (at least a minute
  after the time kept).
- Identity: the UDP identification answer (console id), unicast to the address
  of the session, from that address only, 3 tries of 1.5 s, at each session
  and at each read while unverified. Identifier rule (frozen, in
  `src/devices.js` and the docs): `airtouch5:<console id>:ac<n>` /
  `:zone<n>`; fallback `a-<address>` when the console did not answer the first
  time (or devices already exist under it), kept for good in /data. A console
  id seen later only checks the identity; once known, a session without it is
  "unverified" (nothing shown, only stops), another id is "another console".
  /data unreadable: only the id the created devices prove, nothing written.
- On/off as `air-conditioning/binary` for ACs and zones (as MELCloud,
  CoolMasterNet): a "turn everything off" reaching it only stops. Damper
  opening as `fan/percent` (0-100 %): no core category fits a zone damper
  better. Zone setpoint and temperature only for zones with a sensor.
- Stops (AC or zone off): see the header of `src/app.js`. Kept in /data (the
  save never awaited before the write), one frame for the ACs and one for the
  zones, 1.5 s for their answer, confirmed by a status read after the write;
  resent by contradicting reads 3 times at most (a write counts, nothing else);
  a confirmed stop lifted by two reads in a row showing the target on, or by a
  "switch on" of the target that left; never by the time. A stop cuts a request
  in flight silent for 1 s (that read does not count as a failure).
- Other commands: option checked on arrival and in `beforeSend`; /data must be
  writable (a stop could not be kept otherwise); decided on a fresh status;
  setpoint within the intersection of the cooling and heating limits read on
  the console (the reference warns the document labels them wrongly), to
  0.5 °C, refused outside; modes and fan speeds only those the AC lists;
  "powerful" fan speed neither offered nor shown (no Gladys value);
  "intelligent auto" shown as auto, and sent for auto when the AC has only it.
  Confirmed only by a status showing the value and different from the state
  before; otherwise "sent, without confirmation" and reads at 5 s and 20 s.
  A zone opening or setpoint is refused while a stop of that zone is not seen
  applied (it might open the zone again).

## Next

- Check on a real console: that the identification is answered to the source
  port of the request (else the UDP answer never crosses the container NAT and
  every installation falls back to the address id), that a control is answered
  by the status it changes, the message ids of the answers, and the number of
  TCP clients the console accepts.
- The AC error code (`AC status` byte 7-8 and the error information request) as
  a sensor; the zone low battery flag; the spill and bypass flags.
- Adopting a replaced console (another console id at the same address).

## Not verified

- Never tested with a real device: everything runs against a fake console
  built from the Polyaire document frames and airtouch5py.
- The UDP identification across the container NAT (see Next).
- In the sandbox Gladys, the container starts and connects (no console there).
- Mutation: every guard mutated is caught by a test, except two equivalent
  mutants (the publisher budget check, whose loop sends nothing when no room is
  left; the deadline check of `beforeSend`, which the lane wait already bounds).
