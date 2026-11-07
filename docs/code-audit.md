# Cloud and local driver code review

Reviewed the cloud implementation, all local driver families, shared communication,
learned-command storage, and the app/settings bridge. Confirmed failures were
reproduced with mocked devices, timers, network transports, or an in-memory
filesystem. No real devices, accounts, or customer command files were used.

## Corrections

| Area | Failure corrected |
| --- | --- |
| RM Max EU cloud | A padded acknowledgement could override an explicit cloud/device failure status. Rejected commands now remain failures and do not emit sent-command Flows. |
| Shared cloud lifecycle | Shutdown or a newer initialization could be overwritten by an older initialization resuming after an await. Generation checks prevent that instance from restoring availability or polling. |
| RM Max local transport | Selecting previously verified local control now clears cloud-induced unavailability while retaining cloud diagnostics and authorization state. Homey initialization failures remain visible. |
| Shared local UDP transport | Concurrent requests shared callbacks and timers; teardown could leave promises pending. Each request owns its socket and settlement, and cancellation stops pending retry work. |
| Local learning | Repeated capture polls could overlap. Polling is sequential and bounded, cancellation prevents stale capture updates and saves, persistence results are checked, and generated RF names avoid existing names. Failed Homey UI resets no longer leave the internal learning flag stuck. |
| Local command results | RM3 Mini, RM Pro, RM Plus and RM4 Pro could swallow failed sends and emit successful sent-command Flows. Failures now propagate; acknowledged sends remain successful if a later Homey Flow update fails. |
| Local authentication | RM3-family/A1 settings authentication could use the old IP and interpret decimal device types as hexadecimal. Submitted addresses and decimal types are now used. A rejected Homey address lookup also rejects pairing instead of hanging. |
| Legacy devices | SP1/MP1/Dooya writes await acknowledgements. Dooya closed/open opcodes and custom transition triggers are corrected. A1/MP1 start configured polling. Hysen uses the SDK v3 settings event and cancels delayed startup work. |
| Command storage | Operations serialize per filename across instances, use committed state for mutations, and publish in-memory changes after successful persistence. Delete-all awaits deletion; failed writes do not leave phantom changes in memory. |
| Settings view | The API-unavailable fallback uses an existing logger. Requests within a view serialize access to the bridge's result slot. Stale command/Pronto results and delayed confirmations cannot operate on a newly selected device. Optional command loading no longer blocks the settings view becoming visible. |

The relevant SDK contracts are documented by Athom for
[device settings](https://apps-sdk-v3.developer.homey.app/Device.html#onSettings)
and [app settings views](https://apps.developer.homey.app/advanced/custom-views/app-settings).

## Compatibility

App/driver IDs, paired-device identities, capability IDs, Flow IDs and arguments,
settings names, command-file formats, and dependencies are preserved. There is no
data migration or version change.

Failed actions intentionally reject where they previously reported success.
Dooya transition Flows now execute for devices with the standard closed capability.
Existing local UDP payloads and bounded retry settings are retained; cancellation
prevents further retries. Cloud commands remain single-attempt. Local UDP sockets
now close after their individual request completes.

Storage failures for deletion now reject rather than silently succeeding. A missing
command file remains an empty store; other filesystem read errors are surfaced.
Explicit full-array command restoration still replaces the saved array.

## Verification boundary

The automated regressions cover response validation, cancellation and lifecycle
races, concurrent UDP requests, failed writes and success events, settings handling,
storage transactions, and stale settings-view responses. Syntax checks, unit tests,
dependency audit and Homey package validation are safe local checks. They do not
establish real-device or Homey runtime behavior.

Before release, run the relevant tests on an updated TEST build:

1. Send Power and another mapped/custom command through an existing cloud remote;
   check the appliance response, Homey status, power state and sent-command Flow.
   Exercise Repair and, where already configured and verified, local transport.
2. Send an existing command through each available local RM family. Learn IR/RF,
   cancel a capture, start another capture, and restart the app during learning.
   Confirm no canceled capture is subsequently reported as saved.
3. Check SP1/MP1 state changes, A1/MP1 periodic updates, Dooya open/close and custom
   transition Flows, and Hysen interval/schedule changes. Verify invalid Hysen
   settings are rejected before a write.
4. In the command manager, switch devices while loading commands or generating
   Pronto output. Confirm labels/actions stay with the selected device, then test
   ordinary rename, delete and learning operations.

No installation, physical-device testing, publication, commit or push was performed
as part of this review. Hardware/firmware variants and live Homey settings behavior
remain runtime unverified.

## Changelog

Improved cloud and local command error handling, cancellation, device settings and
polling, and learned-command storage reliability.
