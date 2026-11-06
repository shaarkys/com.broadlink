# RM3 Mini and RM4 cloud remotes

The separate **RM3 Mini (Cloud)**, **RM4 Mini (Cloud)** and **RM4 Pro (Cloud)**
drivers import saved appliance remotes from an EU account in the international
BroadLink app. Internet access is required. Existing LAN drivers and paired
devices remain available; adding a cloud remote does not migrate or replace them.
Magic Home accounts use the existing RM Max driver and cannot sign in here.

## Setup and controls

1. Add the hub and appliance remote in the international BroadLink app and check
   that its buttons work there. Learn additional buttons in that app.
2. Add the matching **(Cloud)** driver in Homey, sign in, and select the home,
   physical hub and appliance remote. Each appliance remote becomes its own
   Homey device. Previewing commands does not operate an appliance.
3. Review the standard control mappings. Only unambiguous machine function
   metadata supplies suggestions; user-defined button names are not guessed.
   Assign other commands manually. Homey's power switch requires separate On
   and Off commands. A power toggle can be a named button instead.
4. Select up to 12 named buttons for the device view. Every imported command is
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
IR only; RM4 Pro also accepts validated RF packets. Discovery uses allowlisted
device types and consistent identifiers, not friendly names. RM Max, RM5 Plus
and unknown types are excluded from these three drivers.

Direct learning from Homey is not implemented. The official learning interface
uses a separate Openproxy/CTC configuration whose credentials and compatibility
with the EU account transport have not been established.

## Evidence and test status

These drivers reuse the existing cloud request, status, queue, recovery and
session handling. RM Max retains its original driver, storage and Flow IDs.
RM3's classic command framing and RM4's length-prefixed framing are checked
against [broadlink-async's remote implementation](https://github.com/DAB-LABS/broadlink-async/blob/master/broadlink_async/remote.py).
The BroadLink EU cloud transport is based on
[homebridge-broadlink-cloud](https://github.com/skymike/homebridge-broadlink-cloud),
with its existing [MIT notice](licenses/homebridge-broadlink-cloud.txt).

Mock tests and Homey package validation cannot confirm physical RM3/RM4 cloud
support. In particular, the EU SDK's acknowledgement of length-prefixed RM4
commands still needs a real-device test. Only the previously observed EU SDK
acknowledgement is accepted; an unfamiliar reply reports failure without a retry,
even if the appliance acted. RM Max Magic Home user reports are not evidence for
these different account/model paths.

Before release, test each available model: add a remote; operate actual IR
buttons (and RF on RM4 Pro); check native and named buttons and generic Flows;
refresh an added, renamed and removed command; edit mappings through Repair;
restart the app; and verify outage recovery and renewed authorization. Confirm
that existing LAN and RM Max devices and Flows still work. Do not publish based
only on mocked tests.

## Changelog

Added separate RM3 Mini, RM4 Mini and RM4 Pro cloud drivers with appliance-remote
pairing, configurable standard controls, named buttons, Flow access to imported
commands, automatic command refresh, connection recovery and Repair.
