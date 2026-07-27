# MRD5 Web Bluetooth POC

A zero-dependency static web page that discovers, connects/pairs, and reads cards from a
**Transact MRD5** BLE reader directly in the browser using the
[Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API).

## Security & disclaimer

This tool does **not** break, bypass, or weaken any encryption, key, or security protocol.
It simply pairs to the reader over standard Bluetooth Low Energy — using the OS's own
pairing flow — and displays the data that the MRD5 hardware **already securely reads** from
the presented credential and chooses to emit over its BLE data characteristic. No card
secrets or cryptographic material are accessed, derived, or exposed by this code; it is a
passive consumer of whatever the reader sends.

The BLE GATT details used here (service/characteristic UUIDs, the plain-text data format)
are not secret or proprietary — they are readily observable with any off-the-shelf BLE
inspection app (e.g. nRF Connect) by anyone with the hardware in hand, and were determined
that way. No confidential documentation, NDA, or protected specification was used or
breached in building this proof of concept.

## Protocol

| Item | Value |
|------|-------|
| MLDP service UUID | `00035b03-58e6-07dd-021a-08123a000300` |
| MLDP data characteristic (notify) | `00035b03-58e6-07dd-021a-08123a000301` |
| Enable notifications | CCCD `0x0100` — handled automatically by `startNotifications()` |
| RX debounce | 80 ms after the last chunk |

Card reads arrive as ASCII text; each read's trimmed string is displayed verbatim (no GTID
vs. access-card interpretation). Nothing is ever written *to* the device.

If the reader is configured to report battery, it also emits a periodic status line like
`BATT:99/136`; the first number is treated as the charge percentage and shown in the
**Battery** field (the meaning of the second number is unknown). These lines are routed to
the battery display rather than the card-reads list. Battery shows **Unknown** until a line
is received.

Device identity is read once after connecting from the standard Bluetooth
**Device Information Service** (`0x180A`). On an MRD5 these report:

| Characteristic | UUID | Example |
|----------------|------|---------|
| Manufacturer Name String | `0x2A29` | `Blackboard` |
| Model Number String | `0x2A24` | `MRD5` |
| Firmware Revision String | `0x2A26` | `1.23.5` |
| Hardware Revision String | `0x2A27` | `4.1` |
| Software Revision String | `0x2A28` | `V3.2` |

Any characteristic the reader does not expose stays **Unknown**. The advertised device
name (e.g. `MRD5-214`) is shown next to the connection status.

> **Note — Serial number is not displayed.** The reader also exposes `Serial Number String`
> (`0x2A25`), but Chrome's Web Bluetooth
> [GATT blocklist](https://github.com/WebBluetoothCG/registries/blob/master/gatt_blocklist.txt)
> forbids reading it as an anti-tracking measure (`readValue()` throws a `SecurityError`), so
> it is intentionally omitted. Native tools like nRF Connect can still read it because the
> Android BLE stack has no such blocklist.

## Running

Web Bluetooth requires a **secure context**, so you must serve the folder over
`http://localhost` (or `https`) — opening `index.html` as a `file://` URL will not work.

```sh
cd mrd5-web-demo
python3 -m http.server 8000
# or: npx serve
```

Then open <http://localhost:8000> in **Chrome or Edge** (desktop with a Bluetooth adapter,
or Android). Click **Connect**, pick the reader from the chooser, and tap a card.

> **Reader prerequisite — disable Bluetooth Security Mode.** The MRD5's **Bluetooth Security
> Mode** must be set to **Off** using the **MRD5 Config** utility provided by Blackboard.
> Without this, the unit will likely still connect and pair, but it will not emit any card or
> battery data over the BLE data characteristic — so the page will sit at "Ready" with
> nothing ever appearing. If you connect successfully but see no reads, check this setting
> first.

## Constraints & notes

- **Browser support:** Chrome / Edge only. Firefox and iOS/Safari do **not** implement
  Web Bluetooth. The page feature-detects `navigator.bluetooth` and shows a banner if absent.
- **User gesture:** connecting must start from the Connect button click — the browser
  requires it.
- **"Bonding" is implicit:** Web Bluetooth has no `createBond` API. If the reader's data
  characteristic requires encryption, Chrome / the OS raises the pairing dialog
  automatically when notifications are enabled. There is nothing to call explicitly.
- **Discovery filter:** the chooser filters on the MLDP service UUID, which assumes the
  reader *advertises* it. If the chooser comes up empty against real hardware, switch to the
  commented-out `acceptAllDevices` fallback in [`app.js`](app.js) and retry.

## Files

- `index.html` — markup: controls, card-reads table, debug log.
- `app.js` — Web Bluetooth flow, RX buffering/debounce, parsing (vanilla ES module).
- `styles.css` — minimal dark styling.
