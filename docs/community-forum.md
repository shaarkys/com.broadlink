Use [Homey](https://homey.app/) together with supported [Broadlink](https://www.ibroadlink.com/) devices.

**App Store – Production:** [https://homey.app/a/com.broadlink](https://homey.app/a/com.broadlink)

**App Store – Test:** [https://homey.app/a/com.broadlink/test](https://homey.app/a/com.broadlink/test)

### Supported devices

#### Universal remote controls

* **RM3 Mini** – IR; local and cloud drivers
* **RM3 Mini Red Bean edition** – IR
* **RM Pro** – IR
* **RM Pro Plus** – IR and RF
* **RM4 Mini** – IR; local and cloud drivers
* **RM4 Pro** – IR and RF; local and cloud drivers
* **RM5 Plus** – IR; local and cloud drivers. For local setup, use the [RM5 Plus pairing instructions and tips](https://community.homey.app/t/app-pro-broadlink-app/6389/832?u=sharkys)
* **RM Max**, device type `0xAF8B` – use the dedicated **RM Max** driver for cloud control

#### Sensors, sockets and other devices

* **A1** – environment sensor
* **SP1** – power socket
* **SP2** – power socket with nightlight and power meter
* **SP3S** – power socket with power meter
* **MP1** – four-way power socket
* **Hysen / Beok** – compatible OEM thermostats
* **Dooya** – compatible motorized curtains

Support may depend on the exact hardware revision, device type and installed firmware. Devices with the same commercial name can contain different hardware.

### Cloud setup: RM3 Mini, RM4 Mini, RM4 Pro and RM5 Plus

These four cloud drivers use an **EU account in the international BroadLink app**. Magic Home accounts use the separate RM Max driver. RM5 Plus supports IR only, and its new cloud driver still requires real-device testing.

1. Fully configure the hub in the BroadLink mobile app. Add the appliance remote and confirm that its buttons operate the appliance. Learn any extra buttons there first.
2. In Homey, choose **Add device → Broadlink**, then **RM3 Mini (Cloud)**, **RM4 Mini (Cloud)**, **RM4 Pro (Cloud)** or **RM5 Plus (Cloud)**.
3. Sign in with your BroadLink account email and password, or choose **Email verification code**. For a code, enter the email registered to that account, press **Send verification code**, check your inbox/spam folder, enter the code and sign in.
4. Select your **Home**, find and select the physical **hub**, then find and select an **appliance remote**.
5. Preview the commands and review their **Standard controls** mappings. Assign commands manually where needed; custom names are not automatically guessed.
6. Select up to **12 Additional buttons** for the device view, then add the device.
7. Repeat for another appliance remote. Each remote becomes its own Homey device.

The preview does not operate your appliances. Native Google/Apple sign-in buttons are not provided; use a supported sign-in method for the email registered to your BroadLink EU account.

#### Power, standard controls and extra buttons

* For one Power key, map **Power button (toggle)**. Homey's standard on/off control sends that same toggle command once for either direction.
* For separate Power On and Power Off keys, map each direction separately.
* A power mapping adds Homey's standard on/off control automatically. You only need to select it as an Additional button if you also want a separate raw command button.
* Map channel, volume and playback controls where appropriate. Use Additional buttons or a command Flow for navigation, mute, digit keys and other commands.
* **Every supported imported command remains available through the command Flow card**, including commands without a standard mapping or one of the 12 visible buttons.

The displayed power value follows the last acknowledged request. IR/RF remotes do not measure the appliance's actual state, and a toggle can become out of sync if another remote is used.

#### Learning, refresh and Repair

Learn or edit commands in the **BroadLink app**, then press **Refresh saved commands** in Homey. An automatic refresh also runs approximately every **five minutes**.

Use **Repair → Change controls** to change mappings and visible buttons without signing in again. Use **Repair → Sign in again** if authorization needs renewing.

Repair must use the original account, Home, hub and remote. The app remembers the last email address and sign-in method; passwords and verification codes are not remembered.

Supported single-code commands are imported. Unsupported, ambiguous or multi-code entries may be skipped; the preview reports this. If a command is removed or renamed in BroadLink, check its saved mappings and Flows after refreshing.

### Cloud setup: RM Max

Choose the dedicated **RM Max** driver in Homey. Its two account options are different services:

**Magic Home**

1. Fully configure the RM Max and your remotes in Magic Home. Check that they operate the appliances there.
2. Obtain the official authorization code under **Me / Third-party services** in Magic Home; menu wording may vary.
3. In Homey's RM Max pairing, select **Magic Home**, enter that authorization code and choose the matching region.
4. Find devices, select a remote or sensor and preview its commands or measurements.
5. Add the entry, then repeat for other supported remotes or sensors.

Homey can use only the functions that Magic Home exposes. Standard controls, custom buttons and temperature/humidity measurements depend on the selected entry.

If Magic Home exposes only one on/off action for a multi-button RF remote, Homey cannot retrieve the other buttons merely because they are visible in the mobile app.

**BroadLink EU**

Select **BroadLink EU**, sign in with a password or email verification code, select your Home and RM Max, preview the saved commands and add the device.

Supported imported IR/RF commands are available through its command Flow card. This RM Max account path has less hardware testing than the reported Magic Home setup.

For both services, learn in the vendor app and use **Refresh saved commands** in Homey afterwards, or wait for the automatic refresh.

**Direct learning from Homey is not implemented for the cloud drivers.**

**RM Max currently relies on cloud control.** The tested firmware rejects local authentication, and no working unlock method has been identified. The optional local-credential test does not unlock the device or establish that local control works.

### Before pairing an RM device locally

Local RM control requires successful authentication and permission for local network communication. Unlock the device where that setting is available.

**Detected lock state:** supported local drivers now automatically show the device's reported lock state through Homey's read-only **Device lock** capability: **Locked**, **Unlocked** or **Unknown**. It is based on discovery responses. **Unknown** means the check was inconclusive; it does not establish whether the device is locked. This capability reports the state and is not an unlock switch.

Cloud control uses the separate setup above; RM Max local authentication is still rejected on the tested firmware, with no working unlock method identified.

In the Broadlink mobile app:

1. Open the RM device.
2. Open its device settings or properties.
3. Find the **Lock device** or **Device lock** setting.
4. Make sure the device is **unlocked**.
5. Return to Homey and start pairing.

The exact menu name can differ between versions of the Broadlink mobile app.

[![Example of the Broadlink device-lock setting|390x500](https://us1.discourse-cdn.com/flex025/uploads/athom/original/3X/f/f/ffed901b72ccc9b8f6fa68513ea90826c09244c4.jpeg)](https://us1.discourse-cdn.com/flex025/uploads/athom/original/3X/f/f/ffed901b72ccc9b8f6fa68513ea90826c09244c4.jpeg)

It is also strongly recommended to assign the Broadlink device a fixed IP address or DHCP reservation.

If Homey still cannot find or authenticate the device:

1. Reset the Broadlink device.
2. Add it again using the official Broadlink mobile app.
3. Confirm that it works in the Broadlink app.
4. Unlock it for local network communication.
5. Add it to Homey again.

### Learning an IR command locally

1. Open the Broadlink device in Homey.
2. Start **Learn IR command**.
3. Point the original remote control towards the Broadlink device.
4. Keep the remote approximately **10–20 cm** from the Broadlink device.
5. Press the required button on the remote.
6. Wait for Homey to confirm that the command was learned successfully.
7. Give the command a clear and unique name.

### Learning an RF command locally

The RM Pro, RM Pro Plus and RM4 Pro first need to detect and lock onto the remote control’s RF frequency. This initial stage is called **RF sweeping**.

Homey does not ask you to select the RF frequency manually. The Broadlink device searches for the transmitted frequency during the sweeping stage but for RM4 Pro, you can choose the frequency manually.

To learn an RF command:

1. Keep the original remote approximately **10–20 cm** from the Broadlink device.
2. In Homey, start **Learn RF command**.
3. Press and continuously hold the required button on the original remote.
4. Keep holding the button until the LED on the Broadlink device changes or switches off. This indicates that the frequency sweep has detected and locked onto the signal.
5. Release the remote button.
6. Wait for the Broadlink LED to switch on again or for Homey to request the actual command.
7. Briefly press the same remote button once more.
8. Wait for Homey to confirm that the RF command was stored successfully.

If learning fails, repeat the procedure while keeping the remote close to the Broadlink device. Do not use only short button presses during the frequency-sweeping stage.

Most ordinary fixed-code RF remotes can be learned. Rolling-code or frequency-hopping remotes generally cannot be copied reliably. This commonly affects garage doors, gates, alarm systems and some security-related products.

### RM4 Pro firmware compatibility

Some RM4 Pro users have reported that firmware **62093** prevents local integrations from communicating with the device. Similar behaviour has also been reported by users of other local-control integrations.

Before changing the firmware, first verify that:

* The RM4 Pro is unlocked in the Broadlink mobile app.
* Homey and the RM4 Pro are connected to the same local network.
* Client isolation or guest-network isolation is disabled.
* The device has been reset, configured again and unlocked.
* The latest test version of the Homey app has been tried.
* A diagnostic report has been submitted after a failed pairing or learning attempt.

If all normal troubleshooting fails and the RM4 Pro uses an affected firmware version, firmware **62092** has been reported by the community as a possible workaround:

http://124.71.130.238/RMBL4-62092-8720-BL-FC-3389.upd.bin

Background information:
[https://www.reddit.com/r/homebridge/comments/1181ex4/caution_to_people_using_broadlink_rm_plugin/](https://www.reddit.com/r/homebridge/comments/1181ex4/caution_to_people_using_broadlink_rm_plugin/)

**Important:** This firmware file and downgrade procedure are not provided or officially supported by the Homey app developer. Installing or downgrading firmware can make the device unusable, introduce security risks or void its warranty. Use it only as a last resort and entirely at your own risk. Never interrupt the device’s power supply during a firmware update.

### Troubleshooting and support

**Support requests and diagnostic descriptions must be written in English.** Please use this Homey Community topic for support and discussion, and send debug logs directly from the **Broadlink app in Homey**.

1. Enable **debug logging** in the Broadlink app settings in Homey.
2. Reproduce the problem and note the time. For RF learning, perform the complete procedure, including frequency sweeping and command capture.
3. Immediately send a **diagnostic report from the Broadlink app itself**.
4. In the report's message/description field, provide the **MOST DETAILED DESCRIPTION POSSIBLE, IN ENGLISH**. Explain the problem in the report itself; logs alone or “it does not work” are not enough.
5. Include the diagnostic report ID in your forum reply. You can disable debug logging afterwards.

Your description should include:

* Exact Broadlink product name, device type/model ID and firmware version.
* Homey model, Homey firmware and Broadlink Homey app version.
* The Homey driver and connection used: local, BroadLink EU cloud or Magic Home; include the account region for cloud problems.
* **Exact steps to reproduce**, which buttons/Flows fail, how often it happens, and the approximate time of the attempt.
* **What you expected and what actually happened**, including the complete error message.
* Whether it worked before, when it stopped, and any recent app, firmware, account or network changes.
* Whether the same operation works in the official Broadlink/Magic Home app; for cloud problems, also check over mobile data with the phone's Wi-Fi disabled.
* For local problems, the **Device lock** capability's displayed state: Locked, Unlocked or Unknown.
* Troubleshooting already attempted and the result of each step.

Please keep the original error messages and do not include passwords, login/authorization codes or account tokens.

GitHub is intended for confirmed application bugs and development requests, not as the primary support channel:
https://github.com/shaarkys/com.broadlink/issues

Before opening a new issue, check whether the same problem has already been reported.

### Credits

This app builds on the work of several open-source projects and contributors. The current application has also been developed with assistance from ChatGPT.

Special thanks to the previous developer, [Remko](https://community.homey.app/u/Remko), for his work on the original application. :heavy_heart_exclamation:

References and related projects:

* https://github.com/mjg59/python-broadlink
* https://github.com/davorf/BlackBeanControl
* https://github.com/frankjoke/ioBroker.broadlink2
* https://github.com/lprhodes/homebridge-broadlink-rm/tree/master/helpers
* http://peter.windridge.org.uk/playing-with-cheap-iot-devices
* https://blog.ipsumdomus.com/broadlink-smart-home-devices-complete-protocol-hack-bc0b4b397af1

### Support the development

## ❤️ Community apps and appreciation

These Homey Community apps are developed and maintained in my spare time.

**Did you know?** In my experience maintaining community Homey apps, only a very small proportion of users choose to support their development financially—even when a new device integration or specific feature has been implemented at their request.

Contributions are never required, but they are a meaningful way to recognise the time invested in development, testing, compatibility updates and ongoing user support. If one of my apps has been useful to you, you can optionally show your appreciation here:

### [❤️ Send an optional thank-you via PayPal](https://www.paypal.me/bkubesa)

### [☕ Support the development on Ko-fi](https://ko-fi.com/bretislavkubesa)

A contribution does not unlock additional features or affect the support you receive. It is simply a way to say *thank you*.

### My Homey apps

| | | |
| :---: | :---: | :---: |
| [![Smart Presence\|72x72](upload://cbTaORH5Euje8FnwJNhiUgknLqN.png)](https://homey.app/a/nl.terryhendrix.smartpresence)<br>[**Smart Presence**](https://homey.app/a/nl.terryhendrix.smartpresence)<br><small>Wi-Fi presence detection</small> | [![Xiaomi Mi Home\|72x72](upload://vGVMmWT6hI6NB9iFcGkWKuuHdqK.jpeg)](https://homey.app/a/com.xiaomi-miio)<br>[**Xiaomi Mi Home**](https://homey.app/a/com.xiaomi-miio)<br><small>Xiaomi Mi Home devices</small> | [![Broadlink\|72x72](upload://gPZprfR6ohSVfS8IyaOkhc05rQY.jpeg)](https://homey.app/a/com.broadlink)<br>[**Broadlink**](https://homey.app/a/com.broadlink)<br><small>IR, RF and smart devices</small> |
| [![TP-Link KASA LAN\|72x72](upload://srGOWaNZXIlgTzJbSRKuGl5WtTg.png)](https://homey.app/a/nu.baretta.tplink)<br>[**TP-Link KASA LAN**](https://homey.app/a/nu.baretta.tplink)<br><small>Local Kasa control</small> | [![Yeelights LAN\|72x72](upload://3ZgvzCuCctH0utILiEtsgp6jG4o.jpeg)](https://homey.app/a/com.yeelight)<br>[**Yeelights LAN**](https://homey.app/a/com.yeelight)<br><small>Local Yeelight control</small> | [![Xiaomi Miija\|72x72](upload://lxQPCx72qDtw7ytZBKXvSEdnaTY.png)](https://homey.app/a/hu.corenet.mitemp)<br>[**Xiaomi Miija**](https://homey.app/a/hu.corenet.mitemp)<br><small>Temperature and humidity sensors</small> |
| [![Octoprint\|72x72](upload://eWVQitmZAZEIDTGmMhdXtpQklaU.png)](https://homey.app/a/no.jonkristian.octoprint)<br>[**Octoprint**](https://homey.app/a/no.jonkristian.octoprint)<br><small>Monitor your 3D printer</small> | [![Virtual Radar\|72x72](upload://mC2LyArn9YiDhK9186TduBgHV1a.jpeg)](https://homey.app/a/com.gruijter.virtualradar)<br>[**Virtual Radar**](https://homey.app/a/com.gruijter.virtualradar)<br><small>ADS-B aircraft tracking</small> | [![enigma2\|72x72](upload://jwDe5F3KQqsm1nYZVjBRnzm1noI.png)](https://homey.app/a/eu.carp3-noctem.enigma2)<br>[**enigma2**](https://homey.app/a/eu.carp3-noctem.enigma2)<br><small>Control Enigma2 receivers</small> |

[**View all my Homey apps →**](https://homey.app/en-us/apps/author/5cc0b0a87a00d60e7682a494/page/0/)
