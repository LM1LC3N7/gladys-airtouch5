# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## airtouch5py

<https://github.com/danzel/airtouch5py> (package `airtouch5py`, version 0.5.1
of 2026-10-30, read on the default branch), by Dave Leaver and contributors, the
library of the Home Assistant `airtouch5` integration. Apache License 2.0
(`LICENSE` of the repository; no `NOTICE` file), the license of this integration too.

Ported: the frame layout of the AirTouch 5 protocol (header, addresses, message
types, CRC16 Modbus), the encoding of the AC and zone control requests and of
the status, ability, zone name and console version requests, the decoding of
their answers (including the 14-byte AC status entries of console 1.2.0 and the
"intelligent auto" fan values), and the UDP identification request and the
shape of its answer. The frames of the protocol document that its tests carry
are used as fixtures in `test/protocol.test.js`.

Changed: the CRC of every frame read is checked (a frame that fails it is
dropped); the lengths, counts and values are bounded and checked; a frame of a
known kind that does not parse closes the session; the setpoint range is the
intersection of the cooling and heating limits; the identification is sent in
unicast to the console only.

The protocol itself is the "AirTouch 5 Communication Protocol" published by
Polyaire. AirTouch is a trademark of Polyaire Pty Ltd; this integration is not
affiliated with Polyaire.
