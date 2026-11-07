# RM3 Mini, RM4 and RM5 Plus cloud remotes

The separate **RM3 Mini (Cloud)**, **RM4 Mini (Cloud)**, **RM4 Pro (Cloud)** and **RM5 Plus (Cloud)**
drivers import saved appliance remotes from an EU account in the international
BroadLink app. Internet access is required. Existing LAN drivers and paired
devices remain available; adding a cloud remote does not migrate or replace them.
Magic Home accounts use the existing RM Max driver and cannot sign in here.

## Setup and controls

1. Add the hub and appliance remote in the international BroadLink app and check
   that its buttons work there. Learn additional buttons in that app.
2. Add the matching **(Cloud)** driver in Homey, sign in with a password or an
   [email verification code](email-code-sign-in.md), and select the home,
   physical hub and appliance remote. Each appliance remote becomes its own
   Homey device. Previewing commands does not operate an appliance.
3. Review the standard control mappings. Only unambiguous machine function
   metadata supplies suggestions; user-defined button names are not guessed.
   Assign other commands manually. For one Power key, use **Power button
   (toggle)**: Homey's standard `onoff` control sends that command once for
   either On or Off. Separate On and Off mappings use their respective commands;
   an unmapped direction fails before sending. All power mappings expose the
   standard power control. Its state follows the last acknowledged request,
   not a measured appliance state. Do not select the same command again under
   **Additional buttons** unless you also want an extra raw command button.
4. Select up to 12 named buttons for the device view. New remotes start with none
   selected; Repair retains your saved selections. Labels such as `0` and `1`
   are the remote's digit keys, not empty placeholders. Every imported command is
   also available through **Send a command** in Flows, even if it has no standard
   mapping or device-view button. No absolute volume, channel, dimmer or climate
   state is inferred from a stateless IR/RF button.
5. After learning or editing in BroadLink, use **Refresh saved commands**. Homey
   also refreshes approximately every five minutes. Use **Repair → Change
   controls** to edit mappings without signing in, or **Sign in again** to renew
   authorization for the same account, home, hub and remote.

One command is active at a time per Homey device, with up to three waiting
operations and a five-second waiting limit. A full/expired queue reports an error;
failed or uncertain physical sends are never automatically repeated. Cloud/network
failures mark the device unavailable and schedule bounded recovery checks.
Rejected authorization requires Repair. Connection checks query the inventory and
commands; they do not transmit IR/RF or prove that the appliance is reachable.
A rejected or unrecognized command response is reported separately, with a safe
reason, numeric statuses and response byte count when available. It does not mark
otherwise working inventory/login unavailable or request Repair. Physical commands
are never retried automatically. This distinction does not prove that an
unrecognized response means the appliance acted.
Explicit documented `INVALID_ACCESSTOKEN`, `ENDPOINT_UNREACHABLE` and
`NO_SUCH_ENDPOINT` error types retain authorization, offline and missing-device
recovery respectively, following [BroadLink's error reference](https://tx.ibroadlink.com/public/openproxy/openproxy/).
Status `-5` means no response from the device and is reported as such; it does
not establish that the physical device is powered off or that login expired.

Cloud SDK license values are URL-encoded before transmission so a literal `+`
survives query decoding. This corrects the request representation; whether it
resolves a particular device's no-response error requires a real-device test.
Existing devices automatically gain `onoff` for power mappings. Obsolete
automatically generated power buttons are replaced after `onoff` is added;
explicitly selected additional buttons and command Flow identities are retained.

## Identity and limits

Device identity binds the account, home, hub and appliance remote. Commands use
the remote ID plus a unique machine function, or the exact unique name when no
unique function is available. Refresh retains mappings and Flow IDs when this
identity stays stable, and updates the underlying code. A name-only command
renamed in BroadLink becomes a new command. Removed commands remain visibly
missing in saved mappings and buttons and fail explicitly; they are not assigned
to a different command. Clear or remap them through Repair. Acknowledged power
state represents the last sent command, not a measured TV state.

Only validated single-code commands are imported, up to 500 per remote and
2 MiB of normalized command data. Ambiguous names, multi-code sequences and
invalid/unsupported packets are counted as skipped in the preview. Minis support
IR only, as does RM5 Plus; RM4 Pro also accepts validated RF packets. Discovery uses allowlisted
device types and consistent identifiers, not friendly names. RM Max and unknown
types are excluded from these four drivers.

Direct learning from Homey is not implemented. The official learning interface
uses a separate Openproxy/CTC configuration whose credentials and compatibility
with the EU account transport have not been established.

## RM5 Plus evidence and test status

The dedicated **RM5 Plus (Cloud)** driver recognizes device type `0x5224` and the
canonical PID `00000000000000000000000024520000`. It does not identify devices by
their friendly names or treat RM5 Plus as RM4 Pro. BroadLink's
[own product listing](https://ebroadlink.com/pages/new-arrivals) describes an IR
remote, and the [Home Assistant RM5 Plus change](https://github.com/home-assistant/core/pull/183058)
confirms the IR-only scope. No RF, temperature, humidity or direct-learning
capabilities are added. The existing local RM5 Plus route through RM4 Mini is unchanged.

The cloud driver reuses the existing EU account, request framing, acknowledgement,
queue, refresh and recovery implementation. The current
[broadlink-async source](https://github.com/DAB-LABS/broadlink-async/blob/master/broadlink_async/remote.py)
supports a related LAN protocol; this is not evidence that RM5 Plus has been
tested through the EU consumer cloud. BroadLink's published
[RM API](https://docs.ibroadlink.com/public/configuration-sdk%2Bctc/rm_related_api/)
describes a different Openproxy route. No RM5-specific consumer-cloud capture or
hardware test was available during implementation.

Mock regressions cover the reported PID, model isolation, RF rejection, exact cloud
request bytes, mapped/named/Flow sends, refreshed codes and Repair with unchanged
identity. Before release, test an actual RM5 Plus with **RM5 Plus (Cloud)**:
sign in to an EU account, add a remote, operate power and other IR buttons, learn
a new button in BroadLink and refresh, then test Repair, restart and outage recovery.
Keep existing local devices and Flows for comparison. Live cloud operation remains
unverified until this test succeeds.

RM5 Plus product reference: BroadLink's
[published RM5 Plus photo](https://ebroadlink.com/cdn/shop/files/6_947b9e9f-1826-4710-90ec-79503be17514.jpg?v=1754536007).

## Shared evidence and test status

These drivers reuse the existing cloud request, status, queue, recovery and
session handling. RM Max retains its original driver, storage and Flow IDs.
Raw IR/RF packet validation follows
[broadlink-async's remote implementation](https://github.com/DAB-LABS/broadlink-async/blob/master/broadlink_async/remote.py).
Cloud `sdkcontrol` payloads use the four-byte command word `02000000` followed by
the raw code for every supported model. Static inspection of the official
[BLLetCoreAndroid 2.14.10 SDK](https://maven.aliyun.com/repository/public/com/ibroadlink/BLLetCoreAndroid/2.14.10/BLLetCoreAndroid-2.14.10.aar)
shows that `bl_protocol_proc` forwards this input to remote HTTP control unchanged;
the local `bl_tfb_data_pack` path adds RM4's two-byte length field separately.
That LAN-only field must not be included in the HTTP API input. Local drivers
keep their existing model-specific wire framing.
The BroadLink EU cloud transport is based on
[homebridge-broadlink-cloud](https://github.com/skymike/homebridge-broadlink-cloud),
with its existing [MIT notice](licenses/homebridge-broadlink-cloud.txt).

User testing confirmed physical RM4 Mini cloud control after the SDK framing
correction. Homey had rejected its short response because it expected the older
padded acknowledgement. Both exact send-command acknowledgements are now accepted:
`02000000` alone, or the same word followed by twelve zero padding bytes.
Response identity, interface and error-status checks still apply; other replies
report failure without a retry. Power state and sent-command Flows update only
after an accepted acknowledgement. These reporting changes still need a Homey
retest. Mock tests and package validation do not establish support for every RM3/RM4/RM5
model; RM Max Magic Home reports concern a different account/model path.

Before release, test each available model: add a remote; operate actual IR
buttons (and RF on RM4 Pro); check native and named buttons and generic Flows;
refresh an added, renamed and removed command; edit mappings through Repair;
restart the app; and verify outage recovery and renewed authorization. Confirm
that existing LAN and RM Max devices and Flows still work. Do not publish based
only on mocked tests.

## Changelog

Added a dedicated RM5 Plus (Cloud) IR driver with EU password/email-code sign-in,
saved-command import, configurable controls, Flows, refresh and connection recovery.
Existing local control is preserved; live RM5 Plus cloud testing is pending.

Fixed success reporting for RM4 cloud commands with short acknowledgements,
restoring power-state updates and sent-command Flows.

Fixed RM4 cloud command framing by removing the LAN-only length prefix from SDK
requests, while preserving local control and standard power controls.

Changed cloud Power controls to Homey's standard on/off capability, corrected SDK
license URL encoding, and clarified cloud device no-response diagnostics.

Improved cloud pairing diagnostics and expired-session recovery, remembered login
details for pairing and Repair, added single-key power controls, and separated
command-response failures from authentication and availability.

Fixed cloud remote Repair loading and named-button initialization, improved button
label readability, and left named buttons unselected for new pairings while
preserving existing selections and Flow identities.

Added separate RM3 Mini, RM4 Mini and RM4 Pro cloud drivers with appliance-remote
pairing, configurable standard controls, named buttons, Flow access to imported
commands, automatic command refresh, connection recovery and Repair.
