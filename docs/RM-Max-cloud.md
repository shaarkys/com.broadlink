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
- **Magic Home authorization code:** uses BroadLink's official authorization and
  discovery interface. This path currently provides diagnostics only. Its known
  API does not establish a saved IR/RF code query, and it may omit the RM Max hub.
  An opaque `aeskeyToken` is not treated as a raw local key. The UI reports this
  limitation and does not create a falsely functional device. BroadLink and
  Magic Home accounts/servers are not assumed interchangeable.
- **Optional local transport:** when a cloud inventory provides a complete raw
  AES key, identifier and MAC, enter the RM Max's private IPv4 address and press
  **Test local credentials**. This sends one firmware query (`0x6a` / payload
  `0x68`) with a five-second deadline. It does not authenticate again, unlock,
  learn or operate an appliance. A valid encrypted response records acceptance
  of those credentials, not an unlocked state. Only then can the device's
  Connection setting be changed to local. Local acceptance on RM Max firmware
  remains unverified until a tester confirms it.

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
refresh retains the previous collection. Identical display names across remotes
include their stable remote identifier so targets can be distinguished. Maximum
import: 50 remotes, 500 commands
and 2 MiB of normalized command data; at most three remote reads are in flight.

## Authorization and diagnostics

Passwords and authorization codes are used during pairing only. Sessions, hub
credentials and saved codes are kept in the device store, not editable settings
or frontend responses. Pairing passes a short-lived, one-use bootstrap reference
to the new device; the sensitive configuration stays in the backend. Protect
Homey backups, which may include stored sessions. Expired EU sessions require
**Repair** and a fresh login; passwords are not retained for automatic login.
Repair verifies the original account, home and device identity before replacement.

Normal logs record inventory counts, command counts, local query outcome and
firmware, refresh failure, and command acknowledgment/failure. They exclude
passwords, tokens, keys, cookies, cloud response bodies and raw command payloads.
A failed local query clears earlier verification. Changing IP or receiving a new
device key invalidates prior local verification. No polling or unlock attempts
are introduced by this driver.

## Manual runtime checks (not executed by the implementation agent)

1. Install a test build through your normal release process. Keep existing devices.
2. Add **Broadlink → RM Max**. For Ruud's current setup, select **Magic Home**, use
   the authorization code documented under My / third-party services, choose the
   correct region and discover. If that option is absent, report that fact; do not
   reset or remove the working vendor pairing. Submit a Homey diagnostic containing
   the inventory counts and safe failure/status, never the authorization code.
3. Where a compatible BroadLink EU account already contains the RM Max and its
   remotes, choose that service, sign in and preview. Confirm all expected commands
   (including ten individually named RF buttons) appear before adding.
4. Run one harmless saved command through the new Flow card and observe the
   appliance. Confirm the sent trigger occurs only after acknowledgment. Test a
   failed request and verify no automatic retry or transport switch occurs.
5. Save the device IP, run **Test local credentials**, and check the normal log.
   A rejection or timeout is a diagnostic result, not an unlocked device. If the
   query succeeds, explicitly select local connection and test one command. Repeat
   with WAN disconnected only after local sending has worked with WAN connected.
6. Restart the app, refresh commands, and use Repair with the same account. Check
   existing command Flow selections remain usable. A different account/home/device
   must be rejected without replacing the saved configuration.
7. Confirm an already-paired legacy RM Max and an RM4 Pro retain their existing
   settings/Flows, and that new RM4 Pro discovery no longer offers RM Max.

## Sources and attribution

- [BroadLink RM Max product image](https://www.ibroadlink.com/productinfo/1417762.html):
  manufacturer image used for the driver artwork.
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

Added a separate experimental RM Max driver with BroadLink EU cloud command import/control, Magic Home authorization diagnostics, and a bounded local-credential test; preserved existing RM Max devices and Flows while removing RM Max from new RM4 Pro pairing.
