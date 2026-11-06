# BroadLink EU email verification-code sign-in

RM3 Mini (Cloud), RM4 Mini (Cloud), RM4 Pro (Cloud) and the BroadLink EU option
in RM Max accept a password or an emailed login code during pairing and Repair.
This uses the existing EU account transport, without a new Google/Apple OAuth
registration. Magic Home continues to use its own authorization-code flow.

## Use and test

1. Open the matching cloud driver in **Add device**, or open **Repair** on an
   existing device. For RM3/RM4 Repair, select **Sign in again**. For RM Max,
   select **BroadLink EU**.
2. Choose **Email verification code**, enter the email registered to the existing
   international BroadLink EU account, and press **Send verification code**.
3. Check the inbox and spam folder, enter the latest code, and press **Sign in**.
   A rejected code can be corrected without requesting another email. Repeated
   sign-in attempts must be at least five seconds apart. If the code has expired,
   request a new one after the resend cooldown.
4. Select the original home, hub and remote, preview commands, then add or repair
   the device. Repair preserves the existing device and Flow command identities.
5. Test a real appliance command, command refresh and an app restart. In a test
   pairing session, also verify a wrong code is rejected, a corrected code works,
   resend is limited, and changing the email invalidates the previous code entry.
   Check that email/password and Magic Home sign-in still work where applicable.

Use the account's actual registered email. A Google/Apple account's public email
does not necessarily identify the same BroadLink account. This feature does not
implement Google/Apple OAuth or change the account's password. There is no
client-side registration or password-reset fallback.

## Limits and diagnostics

Requests have a ten-second timeout and are not automatically retried. The app
limits sending to once per email every 60 seconds and one request globally every
five seconds across cloud drivers/pairing sessions. A failed request reserves
that limit too, because email delivery may have occurred before a timeout.
Five verification attempts require a fresh code. Pairing/challenge state lasts
at most ten minutes locally; this is not a claim about BroadLink's code lifetime.
The server may impose additional limits or expire codes sooner.

After pairing expires, **Send verification code** starts a fresh authorization
session in the same open view, clearing the previous authorization and preview.
Submitting an old code or completing an expired preview remains blocked. Closed
views cannot restart a session. No code is requested automatically.

The app remembers the last email address and login method in local Homey app
settings. New pairings preselect these details; Repair prefers the original
account's saved details. Only the email/method and account association are stored
there, never passwords or verification codes. Older paired devices need one
successful sign-in before the app can remember an email it previously discarded.

The code is cleared from the input when submitted and is never persisted or
logged. Only the resulting BroadLink user ID and session enter existing device
storage. Normal logs record code-request acceptance and safe failure details,
without the email, code, password or returned session. An expired stored session
requires Repair and another login; the app does not request emails automatically.
Pairing logs include a random session reference, each action's start/result and
duration, expired/closed/busy rejections, and explicit session renewal. Safe cloud
failures retain their numeric status without upstream response bodies.

## Protocol evidence and verification boundary

The request format is derived from BroadLink's published account SDK **2.13.2**
and base SDK **2.13.4**, the versions pinned by the
[official Android demo](https://github.com/ibroadlink/APPSDK_Android_Demo/blob/master/app/build.gradle).
The vendor-published [account source artifact](https://maven.aliyun.com/repository/jcenter/com/ibroadlink/BLLetAccountAndroid/2.13.2/BLLetAccountAndroid-2.13.2-sources.jar)
contains `BLAccountImpl.fastLogin`, `sendFastVCode` and
`BLAccountHttpAccessor.generalPost`. The
[base source artifact](https://maven.aliyun.com/repository/jcenter/com/ibroadlink/BLLetBaseAndroid/2.13.4/BLLetBaseAndroid-2.13.4-sources.jar)
declares `/account/fastlogincode` and `/account/fastlogin`.

Both requests reuse the existing password-login encryption and headers.
The send body contains `email`, `companyid` and `lid`; login additionally contains
the string `code` and string `logintry: "true"`. That flag follows the
[official demonstration](https://github.com/ibroadlink/APPSDK_Android_Demo/blob/master/app/src/main/java/cn/com/broadlink/blappsdkdemo/activity/account/AccountVerifyCodeLoginActivity.java).
Server-side account-creation semantics of the flag are not documented. The
[official SDK reference](https://tx.ibroadlink.com/public/appsdk_en/appsdk_04/)
describes verification-code login returning the normal BroadLink login result.

Mock tests verify encrypted request fields, one-attempt transport, errors,
limits, cancellation, both actual pairing scripts and session/device identity.
They do not prove email delivery, live EU acceptance, account compatibility or
Homey UI behavior. No real email/account/device operations were performed during
development. Follow the steps above on a test build before calling it verified.

## Changelog

Added email verification-code sign-in and Repair for BroadLink EU cloud drivers,
with resend and verification-attempt limits, safe error messages and preserved
device/Flow identities.
