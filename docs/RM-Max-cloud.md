# RM Max cloud control and local-credential test

This is an experimental separate `RM_max` driver. Cloud and real-device behavior
still require a tester; mocked protocol and lifecycle tests are not hardware proof.

## Supported paths

- **BroadLink international app, EU account:** sign in, select a home and an
  identified RM Max, preview saved commands, and add the device. Each supported
  single-code IR/RF button becomes a separate autocomplete choice in **Send a
  saved command**. Ten RF buttons can therefore be represented independently if
  the account returns all ten. Learn new buttons in the BroadLink app, then use
  **Refresh saved commands** in Homey. Learning directly in Homey is not provided.
- **Magic Home authorization code:** add each supported remote or sensor as its
  own Homey device. Preview shows only advertised functions. Power, channel,
  volume steps, mute and playback use documented cloud intents; custom buttons
  are imported when `DNA.CustomizedRemoteControl` advertises them. Temperature
  and humidity are available only for their matching sensor interfaces. The
  generic command Flow covers exposed buttons; number-based channel and volume
  actions require the corresponding advertised action. Unsupported requests fail
  before sending. Power values represent the last acknowledged request, not a
  measurement of the appliance. BroadLink and Magic Home accounts/servers are
  not interchangeable.
- **Learning and cloud updates:** learn in the vendor app. Refresh commands and
  sensors with the device button or Flow, or wait for the automatic five-minute
  refresh. Cloud button identifiers remain stable when the list is reordered or
  new buttons are added. Renaming a custom button changes its identity. If Magic
  Home exposes only one power action for a ten-button RF remote, Homey can offer
  only power on/off. No hidden button names are guessed. Homey learning is not
  implemented: this authorization route has no verified learning/storage API.
- **Optional local transport:** when a cloud inventory provides a complete raw
  AES key, identifier and MAC, enter the RM Max's private IPv4 address and press
  **Test local credentials**. This sends one firmware query (`0x6a` / payload
  `0x68`) with a five-second deadline. It does not authenticate again, unlock,
  learn or operate an appliance. A valid encrypted response records acceptance
  of those credentials, not an unlocked state. Only then can the device's
  Connection setting be changed to local. Local acceptance on RM Max firmware
  remains unverified until a tester confirms it.
  This raw-code path applies to BroadLink EU only. Magic Home's `aeskeyToken` is
  opaque authorization material, not a demonstrated AES key. Its intents contain
  no raw codes, so local transport and unlock are not enabled for Magic Home.

Cloud operation requires Internet access. No failed physical send is retried or
automatically sent through another transport. Acknowledgment does not measure
the appliance's actual state.

## Existing devices and Flows

Existing RM Max devices paired as `RM4_pro` retain their data, capabilities,
commands, settings and Flow IDs. There is no automatic migration or deletion.
The RM4 Pro add-device entry now excludes RM Max; its runtime compatibility
branch remains unchanged. New RM Max devices use separate Flow cards and do not
inherit existing Flows automatically. Keep working devices until a new setup has
been verified.

Command identity uses the remote endpoint and command name. Reordering or adding
buttons preserves existing selections. Renaming a button in the vendor app
requires selecting that renamed command again in affected Flows. Duplicate names
inside one remote and multi-code sequences are skipped explicitly. A failed
cloud import retains the previous collection. A later sensor/UI error may leave a
successfully imported collection in place while the device reports unavailable.
New capabilities are added idempotently; existing capabilities are retained to
preserve Flows if the cloud stops advertising an action. Their listeners reject
actions that are no longer present. Identical display names across EU remotes
include their stable remote identifier so targets can be distinguished. Maximum
import: 50 remotes, 500 commands
and 2 MiB of normalized command data; at most three remote reads are in flight.

### Recovery from v3.1.81 TV initialization failures

The test version used generic `button.volume_*`, `button.channel_*` and playback
placeholders and queried their dynamic metadata. Homey could reject that lookup
with `Invalid Capability: button.volume_up`, preventing initialization and Repair.
The initialization handler also incorrectly described this as missing authorization.

On update, stored command metadata is rebuilt from the saved endpoint without
changing command IDs, payloads or device identity. Native `volume_up/down`,
`channel_up/down` and `speaker_*` controls replace the corresponding placeholders;
Play/Pause use declared stateless app capabilities with their own icons. The seven
old control placeholders are removed only after supported replacements are added.
Generic command Flow selections remain valid. Any direct HomeyScript references to
those test-only placeholder capability IDs must use the replacement IDs instead.
Controls that later disappear from cloud discovery are still retained as described
above. Native control metadata is provided by Homey rather than queried dynamically.

Keep the existing TV device when updating. Initialization should perform the
migration automatically. If authorization is subsequently rejected, use **Repair**
with a fresh Magic Home code and select the same TV entry. A control setup failure
is reported separately from a cloud authorization failure.

## Authorization and diagnostics

Passwords and authorization codes are used during pairing only. Sessions, hub
credentials and saved codes are kept in the device store, not editable settings
or frontend responses. Pairing passes a short-lived, one-use bootstrap reference
to the new device; the sensitive configuration stays in the backend. Protect
Homey backups, which may include stored sessions. Expired EU sessions require
**Repair** and a fresh login; passwords are not retained for automatic login.
Repair verifies the original account, home and device identity before replacement.
For Magic Home, Repair checks the region, endpoint identity and previously
supplied physical/module identifiers. A valid refreshed Magic Home session is
persisted even when a subsequent request fails; a physical command is never
resent automatically.

Normal logs record inventory counts, command counts, local query outcome and
firmware, refresh failure, and command acknowledgment/failure. They exclude
passwords, tokens, keys, cookies, cloud response bodies and raw command payloads.
RM Max operation logs also record the operation type, start/finish duration,
queue depth, waiting duration, expiration and cancellation. These labels describe
commands, refreshes, Repair, settings or credential checks; they contain no
user-defined button names. A waiting timeout includes the active operation type
and elapsed duration so a diagnostic can identify what was still running.
Magic Home discovery also logs numbered endpoint summaries: parent relationships,
allowlisted categories, interfaces and protocol actions/properties, and counts of other
capabilities, including the number of custom-remote actions. Names, endpoint identifiers,
unknown interface strings and property values
are omitted. Summaries are limited to 20 endpoints and 32 capabilities per endpoint.
The pairing list uses the same numbers; a product-ID match does not prove an entry
is a separate physical hub.
A failed local query clears earlier verification. Changing IP or receiving a new
device key invalidates prior local verification. No unlock attempts are introduced.

## Connection checks and recovery

After initialization or Repair, a check is scheduled after one second. Subsequent
checks run five minutes after the previous check finishes and also refresh cloud
commands/sensors. One cloud-check timer and one operation are active per device.
Busy automatic checks are deferred. Up to three user operations can wait behind
an active command, manual operation or automatic check, in arrival order. Each
waiting operation has a five-second deadline and its own timeout. A full queue
or expired wait returns an explicit error without starting that operation.
Deadlines are checked again before starting, including when a timeout callback
is delayed. Failed requests release the queue; failed physical sends are not
retried. Shutdown and reinitialization cancel all waiting operations and their
timers, invalidate outstanding work and drain the active request before starting
another session/check. The active operation is never forcibly released while
its request is still pending. This addresses overlapping button presses; a
persistent stall still needs a diagnostic identifying the unfinished operation.

Missing/offline endpoints, failed sensor queries and network failures make cloud
devices unavailable with an explanation. Transient failures retry after 1, 2, 4,
8 and then at most 15 minutes. A successful check restores availability. Rejected
authorization stops checking and requests **Repair**. Magic Home tokens refresh
before expiry; EU expiry still requires a fresh login. Cloud discovery without an
`isReachable` value establishes cloud access only; it does not prove the appliance
is online. Previously verified EU local sending remains usable during a cloud
outage. New physical sends are never retried or switched to another transport.

## Manual runtime checks (not executed by the implementation agent)

1. Install a test build through your normal release process. Keep existing devices.
2. Add **Broadlink → RM Max**. For Ruud's current setup, select **Magic Home**, use
   the authorization code documented under My / third-party services, choose the
   correct region and discover. If that option is absent, report that fact; do not
   reset or remove the working vendor pairing. Submit a Homey diagnostic containing
   the inventory counts and safe failure/status, never the authorization code.
   Select the TV or KaKu remote, preview its actions and add it. Add other remotes
   or sensors individually. KaKu currently advertises power only in Ruud's report.
3. Where a compatible BroadLink EU account already contains the RM Max and its
   remotes, choose that service, sign in and preview. Confirm all expected commands
   (including ten individually named RF buttons) appear before adding.
4. Test power, volume/channel steps and playback where present. Confirm the actual
   appliance response and that the sent trigger occurs only after acknowledgment.
   Learn a new custom button in the vendor app; refresh manually, then confirm an
   automatically refreshed button appears within five minutes. Check old Flow
   selections still work. Sensor-only devices must show real reported readings.
5. For BroadLink EU only, save the device IP, run **Test local credentials**, and check the normal log.
   A rejection or timeout is a diagnostic result, not an unlocked device. If the
   query succeeds, explicitly select local connection and test one command. Repeat
   with WAN disconnected only after local sending has worked with WAN connected.
6. Briefly disable Internet, wait for a check and confirm cloud devices become
   unavailable. Restore Internet and confirm automatic recovery; use **Check cloud
   connection** for a manual check when available. Reject/expire authorization and
   verify the unavailable message requests Repair. Renew through Repair and confirm
   checks resume once. Restart the app, refresh commands, and Repair with the same account. Check
   existing command Flow selections remain usable. A different account/home/device
   must be rejected without replacing the saved configuration.
7. Confirm an already-paired legacy RM Max and an RM4 Pro retain their existing
   settings/Flows, and that new RM4 Pro discovery no longer offers RM Max.
8. Press two or three different RM Max controls quickly while the cloud is
   responsive, and repeat during a manual command refresh. Confirm they execute
   once, in order. With a slow request, confirm a waiting operation expires after
   five seconds and never executes later. Restart while work is waiting and
   confirm the waiting commands are cancelled. If the driver remains busy,
   submit a diagnostic before restarting so the active operation and duration
   are available; report whether the appliance actually responded.

## Sources and attribution

- [BroadLink RM Max product image](https://www.ibroadlink.com/productinfo/1417762.html):
  manufacturer image used for the driver artwork.
- [BroadLink cloud control documentation](https://tx.ibroadlink.com/public/dnaproxy/message_table/):
  documented remote-control interfaces and custom-panel action discovery; actual
  availability through a Magic Home account requires verification.
- [homebridge-broadlink-cloud](https://github.com/skymike/homebridge-broadlink-cloud):
  EU login, family/device/remote discovery and raw-code cloud transport. Adapted
  protocol code retains its [MIT notice](licenses/homebridge-broadlink-cloud.txt).
- [BroadLink's official Magic Home integration](https://github.com/ibroadlink/ha_magic_home):
  authorization, refresh and discovery/control envelopes. Only demonstrated
  interfaces are implemented; its capability API is not presented as raw learning.
- [broadlink-async device protocol](https://github.com/DAB-LABS/broadlink-async/blob/master/broadlink_async/device.py):
  firmware query and encrypted UDP framing. The local test requires strict peer,
  packet counter, MAC and checksum validation and fails closed otherwise.

No production dependencies, app version changes, commits, publishing or device
installation are part of this implementation.

## Changelog (unreleased)

Improved RM Max handling of overlapping controls with a three-operation queue, a five-second waiting limit, cancellation of expired or stopped work, and operation timing diagnostics.

## Changelog (v3.1.82)

Fixed RM Max TV initialization and Repair by migrating control placeholders to supported Homey capabilities, preserving saved command Flow selections and reporting control setup errors separately from authorization failures.
