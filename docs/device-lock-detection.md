# Broadlink device-lock capability and warning

Paired devices now check their lock state at initialization and approximately
once a minute. If the device explicitly reports that it is locked, Homey shows:

> Discovery reports that this device is locked. Homey attempts an automatic
> unlock using the stored session. If the warning persists and your Broadlink
> app offers Lock device, turn it off. The warning clears only after discovery
> reports unlocked (checks about once a minute).

RM Max (`0xAF8B`) has separate guidance: its app may not offer a lock switch,
the firmware may reject `set_lock`, and the discovery flag alone does not prove
whether local commands work. Pairing instructions also make the lock switch
conditional on its availability.

The implementation is shared by all 13 driver families in this app: A1, Dooya,
Hysen, MP1, RM3 mini, RM4 mini, RM4 Pro, RM plus, RM Pro, SCB1E, SP1, SP2, and
SP3S. Actual detection depends on the device firmware returning the lock flag.
Older/short discovery replies or unrecognized flag values remain **unknown**.
There is no claim that every model supports locking.

The read-only **Device lock** capability displays **Locked**, **Unlocked**, or
**Unknown**. It is included for newly paired devices and added once to existing
devices during initialization. Initialization resets its value to Unknown until
discovery completes. Missing flags and failed checks also display Unknown;
they retain any warning based on the last confirmed locked reply.

Every completed check logs the state through normal Homey logging, even with
debug logging disabled. Inconclusive results include the reason and last
confirmed state. Capability migration and update failures are logged without
preventing device initialization or lock warnings.

## Detection and compatibility

The flag is byte `0x7F` in the unencrypted discovery response, following the
[upstream Broadlink discovery/hello implementation](https://github.com/mjg59/python-broadlink/blob/master/broadlink/device.py).
Only explicit `0` and `1` values are accepted. The reply IP, MAC address, and raw
device type must match the paired device before applying a lock state.

Each check sends unicast discovery to the device's configured IP on a separate
communication instance/socket, with a five-second timeout. It never uses the
IR/RF/control socket, authenticates, or changes a key. A confirmed locked reply
can now initiate the bounded unlock attempt described below on that isolated
connection.
The next check is scheduled only after the previous check completes. Repeated
initialization replaces the check loop; deletion and uninitialization cancel
pending checks and close their socket. Late replies are ignored.

A timeout or authentication error is not treated as evidence of a lock. An
inconclusive check does not clear an already confirmed lock warning. A confirmed
unlocked reply clears the lock warning while preserving current unrelated
warnings. IR/RF learning messages can coexist with a lock warning, and their
cleanup does not remove it. Warning updates are serialized through Homey's
[Device.setWarning API](https://apps-sdk-v3.developer.homey.app/Device.html#setWarning).

The warning does not block pairing, device controls, or Flows. The lock flag is separate from the
RM4 zero-temperature/humidity diagnosis; zero readings are not lock evidence.

## Automatic unlock attempt

After matching the discovery IP, MAC and device type, Homey attempts
`set_lock(false)` once per continuously locked period. An explicitly unlocked
reply or restarting the monitor permits another attempt; unknown replies and
timeouts do not reset the attempt limit. There is no automatic retry after
device rejection or timeout, and no attempt on an identity mismatch.

The operation follows upstream's 80-byte `0x6A` payload: four zero command bytes,
the existing UTF-8 device name, and a boolean lock byte at offset `0x43`. Since
this packet also sets the name, only the name from a complete, valid discovery
reply is used. The Homey label is never substituted. An invalid or unavailable
name skips the attempt. The name payload is excluded from debug logging.

The attempt copies the stored 16-byte key and four-byte ID into the isolated
connection. Missing/invalid credentials skip it until authentication has been
completed through the existing app path. It does not bootstrap authentication,
replace the active command session, or bypass rejected authentication. This
avoids changing a session while another driver command is running.

Each attempt sends once with a five-second timeout. Normal logs distinguish
started, skipped, accepted-awaiting-confirmation, and failed (with the underlying
safe error). An accepted command **does not** clear the warning or publish
Unlocked: only a subsequent matching discovery reply does that. Uninitialization,
deletion, monitor replacement, and IP changes suppress stale completion updates;
stopping the monitor closes its socket and prevents retry traffic.

## RM Max protocol compatibility

RM Max remains paired through `RM4_pro`, preserving device data, settings,
capabilities and Flow IDs. Only raw device type `0xAF8B` selects legacy `<I`
framing for IR learning, code reading/sending, RF sweeping, frequency detection,
RF capture (including manual frequency), and sweep cancellation. Responses use
legacy offsets. Captures retain the existing two-byte Homey status prefix;
transmission accepts both that stored format and raw IR/RF packets and removes
padding beyond the declared command length. Failed RM Max transmissions reject
the action and do not fire sent triggers. RM4 sensor polling is skipped for
RM Max because it does not use the RM4 HTS2 sensor protocol.

This follows the [RM Max framing report](https://github.com/mjg59/python-broadlink/issues/829#issuecomment-4985869826)
and the actual [PR 838 diff](https://github.com/mjg59/python-broadlink/pull/838/files).
It does not resolve every authentication issue: [another V62130 tester reports authentication failure before commands](https://github.com/mjg59/python-broadlink/pull/838#issuecomment-5083900342).
No Magic Home server/client setting is assumed to be an unlock mechanism. Other
RM4 Pro models retain their existing framing and sensor behavior.

### Authentication before unlocking

A discovery reply reporting `locked` is not an authenticated session. A newly
paired RM Max can return a 56-byte authentication error with no encrypted ID/key.
In that case automatic unlocking is skipped, and IR/RF framing changes cannot
yet be exercised. This is different from an unlock command being rejected.

Authentication now matches upstream's 80-byte payload, including all 16 client
identifier bytes and the six-byte `Test 1` name, without adding an extra AES block.
Pairing and RM4 Pro/RM Max manual authentication retain the raw decimal discovery
type (`44939` becomes `0xAF8B`, not `0x4939`); manual authentication uses the
submitted IP address. These shared protocol corrections do not bypass firmware
authentication restrictions.

Device rejection codes and response length are checked before extracting the
session. Authentication failures are logged through normal Homey error logging,
including with debug disabled, rather than being reduced to a missing-payload
decryption error. Raw authentication replies and session keys are not logged.
Malformed or empty successful replies cannot install an empty key/device ID.

Existing Flow IDs, capability IDs, device identities, settings, stored commands,
and dependency versions remain unchanged. The only migration adds the new
`device_lock_state` capability when missing. Lock state is rechecked after app
restart; no stored device data or commands are migrated.

## Implementation and verification

- `lib/Communicate.js`: discovery flag parsing and an optional zero reply-port
  parameter for isolated unicast checks. Existing pairing callers keep their
  original default port behavior.
- `lib/BroadlinkDevice.js`: shared check lifecycle, capability migration and
  updates, normal state logging, and combined warning rendering.
- `.homeycompose/capabilities/device_lock_state.json`, `assets/device-lock.svg`,
  and all 13 driver Compose manifests: read-only enum sensor and its icon.
  `app.json` is regenerated by the Homey CLI.
- RM3 mini, RM4 mini, RM4 Pro, SCB1E, and SP2 device deletion overrides: stop the
  new check loop. The other drivers inherit cleanup directly or through a parent.
- `locales/en.json` and `locales/nl.json`: user warning text.
- `tests/BroadlinkLock.test.js` and `tests/SCB1E.test.js`: response parsing,
  identity checks, unknown/error behavior, warning preservation, isolated
  communication, capability migration and values, normal logging, timer
  replacement, and cleanup across all drivers.

Regression coverage now also includes upstream-compatible lock payloads, UTF-8
name preservation, missing-session skips, one-shot timeout/rejection behavior,
discovery confirmation, cancellation during unlock, and RM Max IR/RF packet
fixtures and failed-send behavior. No lint or separate build script is configured.
No dependencies or manifest definitions change for this update.

## Manual runtime test

1. On an authenticated device with a lock option, enable **Lock device** in the
   Broadlink app. Within about a minute confirm the Locked capability, warning,
   and a single automatic unlock attempt in normal logs. Confirm the device's
   Broadlink name remains unchanged. If accepted, wait for the next discovery
   check to confirm Unlocked and clear the warning; acceptance alone must not do so.
2. If rejected, confirm the original error is logged, the warning remains, and
   later locked checks do not repeat the command. Disable the lock manually if
   the app offers it. If no stored session exists, confirm a skip is logged;
   authenticate through the existing device settings and wait for the next check.
3. Repeat with an already paired RM4 Pro and one other supported device family
   whose firmware exposes the flag. Check normal commands and sensor polling.
4. While locked, try an IR/RF learning action. Confirm its progress/error message
   does not permanently replace the lock warning.
5. After detecting a lock, make the device unreachable. The failure must not be
   reported as a newly detected lock or as an unlock. The capability must show
   Unknown, logs must explain the inconclusive check, and the confirmed lock
   warning must remain. Restore connectivity and confirm the current explicit
   lock state is applied.
6. Restart the app and repeat the lock/unlock test. On an older device without
   the extended discovery flag, confirm the capability remains Unknown and no
   false lock warning appears. Confirm repeated initialization does not add the
   capability twice or create duplicate check loops.
7. On RM Max, confirm the model-specific warning does not require a nonexistent
   app toggle. Record firmware version and test existing stored IR/RF commands,
   learning a new IR code and sending it, automatic RF learning, and manual RF
   learning at a frequency supported by the hardware. Confirm failed commands
   reject the Flow and do not fire sent triggers. Confirm RM4 HTS2 sensor requests
   are not issued. Repeat ordinary IR/RF and sensor checks on an RM4 Pro to check
   that its existing behavior is retained.
8. For the RM Max authentication failure, retry pairing or the device's existing
   Authenticate setting with the updated build. Record firmware/SDK version and
   the normal authentication result. If authentication still fails, submit the
   diagnostic containing its signed Broadlink error code and reply length. If
   it succeeds, wait for the next lock check and distinguish unlock acceptance
   from the subsequent discovery confirmation. Do not treat an authentication
   fix as hardware-verified until this retest succeeds.

Physical Homey/device behavior remains unverified until these checks are run.
Analysis used Graft queries/skeletons/caller searches, targeted source reads,
the upstream protocol implementation, and official Homey SDK documentation.
