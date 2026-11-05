# gladys-airtouch5

Unofficial [Gladys Assistant](https://gladysassistant.com) external
integration for **AirTouch 5** consoles (Polyaire): the air conditioners and
zones of a ducted system become Gladys devices (on/off, mode, fan speed,
setpoint, damper opening, temperatures), over the local protocol of the
console (TCP 9005, identity in UDP 49005). No cloud. Stops need no option;
other commands are off by default.

Never tested with a real device. Not affiliated with Polyaire.

- User guide: [English](docs/en.md), [français](docs/fr.md)
- Protocol logic ported from [airtouch5py](https://github.com/danzel/airtouch5py)
  (Apache-2.0): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- Changes: [CHANGELOG.md](CHANGELOG.md); decisions and next steps:
  [TODO.md](TODO.md)

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm audit --omit=dev
npx --yes github:GladysAssistant/integration-store .
```

`src/app.js` holds the integration (reads, identity, stops, commands),
`src/airtouch/` the protocol, the TCP session and the UDP identity,
`src/handlers.js` the SDK wiring shared with the tests (against the SDK's fake
Gladys and a fake console on a real local socket, `test/helpers/`). See
[CLAUDE.md](CLAUDE.md) for the project rules.

## License

Apache License 2.0, see [LICENSE](LICENSE).
