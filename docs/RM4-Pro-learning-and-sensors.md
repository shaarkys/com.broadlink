# RM4 Pro: manual RF learning and sensor diagnosis

## Learning at a known frequency

Open the Broadlink app settings in Homey, select an RM4 Pro in the command manager,
enter its remote's frequency in MHz (for example `433.92`), and click **Learn RF**.
Press the remote button repeatedly while capture is active. Follow the Homey
device's learning status, then click **Refresh commands** after learning finishes.
The initial settings-page message acknowledges that learning started, not that a
command was captured successfully.

Leave the frequency blank (or use `0`) for automatic scanning. The existing
device RF learning button continues to use automatic scanning. A manual frequency
is used only for that learning attempt; it is not a persistent device setting.

Accepted manual ranges are 305–335 and 430–440 MHz. The actual band must be
supported by the particular regional hardware. Manual frequency entry does not
add support for rolling codes, FSK, or other unsupported remote protocols.
[Broadlink's developer response](https://apps.apple.com/tw/app/broadlink/id1450257910)
describes those bands and protocol limitations.

The capture command is `0x1B` with a four-byte little-endian frequency in kHz;
`433.92` MHz is encoded as `00 9F 06 00`. RM4 framing includes an eight-byte
command/data length. Capture is started once, then separate `0x04` requests read
the result. This follows the
[upstream python-broadlink implementation](https://github.com/mjg59/python-broadlink/blob/master/broadlink/remote.py).

## What the supplied v3.1.70 log proves

The reporter's log identifies **0x520b**, including the actual packet headers.
The working device described by the maintainer is **0x5213**. Both are mapped to
RM4 Pro locally in `lib/DeviceInfo.js` and use the same sensor implementation in
[python-broadlink](https://github.com/mjg59/python-broadlink/blob/master/broadlink/__init__.py).
This does not establish that their firmware, regional RF hardware, or attached
sensor cables are identical.

At 03:04:06 and 03:05:06, the device accepts sensor command `0x24` with outer
error code zero. The decrypted frame is:

```text
0A 00 24 00 00 00 00 00 00 00 05 00 00 00 00 00
```

The app strips the first four bytes before the sensor parser sees the response.
The remaining two command bytes are skipped by the sensor parser, so its four
measurement bytes are all zero. The following `05` is outside the measurement
fields; there is no verified meaning for it here. It must not be interpreted as
5% humidity or a proven sensor error code.

The request succeeds and yields a decryptable response, which argues against a
device-lock/authentication failure for these reads. The log cannot prove whether
the HTS2 sensor accessory is missing, disconnected, faulty, or whether firmware is
returning an empty reading. The accessory is a sensor in the USB power cable, not
an arbitrary RF temperature sensor; see the
[Broadlink HTS2 specification](https://www.broadlinkcolombia.com/wp-content/uploads/2020/09/HTS2.pdf).

Two independent parser/request defects were corrected:

- The RM4 sensor request now declares its four-byte command length (`04 00`).
  The old request used `00 00`; the reporter's firmware nevertheless acknowledged it.
- Temperature bytes are signed, and fractional temperature/humidity bytes are
  hundredths. For example `[21, 5]` means **21.05**, not **21.5**. Standard and
  legacy Homey capabilities both receive the corrected values.

Short responses are rejected before updating capabilities. All-zero readings
produce a diagnostic directing attention to the sensor cable and Broadlink app;
the values are preserved as reported, since the log alone cannot establish an
invalid-reading sentinel. These fixes are not proof that this user's missing
measurements are resolved.

## Separate transport finding

`Communicate._check_data()` uses a two-second interval without waiting for the
previous `send_packet()` to finish. `sendto()` stores a single callback and timer
per communication instance, while a request can wait 20 seconds and retry. Slow
responses or simultaneous sensor polling and learning can therefore overlap,
overwrite callbacks, and misroute responses. The log's successful replies followed
by timeouts and late RF reads after cancellation are consistent with this defect.
They do not prove it caused the two zero sensor readings.

The shared transport was not redesigned in this change. It affects multiple
drivers and remains a separate reliability risk under slow or concurrent traffic.

## Manual hardware verification (not performed by Codex)

1. On the working RM4 Pro, compare Homey and Broadlink-app temperature/humidity
   over at least two one-minute polls. Check standard and legacy capabilities.
2. On the reporter's unit, confirm the USB cable includes the HTS2 accessory,
   check its connection, and compare the same unit's readings in the Broadlink app.
   If the Broadlink app also has no readings, investigate the cable/power/hardware
   first. If it has real readings while Homey returns zeros, capture fresh debug
   logs with the corrected request and record firmware and raw device type.
3. With a fixed-code 433.92 MHz remote, use manual learning and repeated short
   presses. Confirm the log says scanning was skipped, a command is stored, and
   replay through the existing send-command Flow works. Repeat with the Wen remote;
   successful capture/replay of that remote is not established by this patch.
4. Leave the frequency blank and repeat automatic learning with a known working
   remote. Also check the existing device RF learning button and one IR learn/replay.
5. Attempt learning without pressing a remote button. Confirm failure clears the
   learning state, stores no command, and a later attempt can start.
6. Keep debug logging enabled through a sensor polling interval during RF learning;
   check for timeouts or late responses associated with the unresolved transport issue.

## Scope and local verification

Implementation: `app.js`, `drivers/RM4_pro/device.js`, `lib/Communicate.js`,
`settings/index.html`, and `settings/js/settings.js`. Regression coverage:
`tests/RM4ProClimate.test.js` and `tests/RM4ProLearning.test.js`.

No capability/Flow IDs, device identity, stored commands, dependencies, version,
or manifest definitions change. No migrations are added. Homey Compose validation
regenerated the manifest with no content diff.

Verified locally: JavaScript syntax, `npm test` (50 passing tests),
`homey app validate` (installed CLI defaulted to publish level), and
`git diff --check`. There is no configured lint or separate build script.
The settings UI logic was tested with a mocked DOM, not in a live Homey WebView.
Physical device behavior remains unverified. No Homey deployment, Git commit,
push, or publishing was performed. Orchestration route: `solo`.

Analysis used `graft map`, `graft ask --source`, `graft skeleton`, `graft callers`,
`graft grep`, targeted source reads, installed Homey CLI source inspection,
and the upstream sources linked above.
