Use [Homey](https://homey.app/) together with supported [Broadlink](https://www.ibroadlink.com/) devices.

**App Store – Production:** https://homey.app/a/com.broadlink

**App Store – Test:** https://homey.app/a/com.broadlink/test

### Local and cloud control

The app offers two ways to control supported RM devices:

| Connection | How it works |
| --- | --- |
| **Local network** | Homey communicates directly with the Broadlink device. Local authentication must work and the device must permit local access. |
| **Cloud** | Homey uses commands and functions exposed by your BroadLink or Magic Home account. Internet access is required. |

Cloud remotes are added as separate Homey devices. Existing local devices and their Flows continue to work; they are not automatically converted to cloud devices.

### Supported devices

#### Universal remote controls

| Device | Connection and functions |
| --- | --- |
| **RM3 Mini** | Local IR; **RM3 Mini (Cloud)** for compatible BroadLink EU devices |
| **RM3 Mini Red Bean edition** | Local IR |
| **RM Pro / RM Pro Plus** | Local IR and RF |
| **RM4 Mini** | Local IR; **RM4 Mini (Cloud)** |
| **RM4 Pro** | Local IR and RF; **RM4 Pro (Cloud)** |
| **RM5 Plus** | Local control; follow the [RM5 Plus pairing instructions and tips](https://community.homey.app/t/app-pro-broadlink-app/6389/832?u=sharkys) |
| **RM Max** | Dedicated **RM Max** driver, with BroadLink EU or Magic Home cloud support |

Cloud discovery checks supported device types. A similar product name alone does not guarantee compatibility. The RM3/RM4 cloud drivers do not include RM5 Plus or RM Max.

#### Sensors, sockets and other devices

* **A1** – environment sensor
* **SP1** – power socket
* **SP2** – power socket with nightlight and power meter
* **SP3S** – power socket with power meter
* **MP1** – four-way power socket
* **Hysen / Beok** – compatible OEM thermostats
* **Dooya** – compatible motorized curtains

Support depends on the exact hardware revision, device type and firmware.

### Cloud setup: RM3 Mini, RM4 Mini and RM4 Pro

These three cloud drivers use an **EU account in the international BroadLink app**. Magic Home accounts use the separate RM Max driver.

1. Fully configure the hub in the BroadLink mobile app. Add the appliance remote and confirm that its buttons operate the appliance. Learn any extra buttons there first.
2. In Homey, choose **Add device → Broadlink**, then **RM3 Mini (Cloud)**, **RM4 Mini (Cloud)** or **RM4 Pro (Cloud)**.
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

Use **Repair → Change controls** to change mappings and visible buttons without signing in again. Use **Repair → Sign in again** if authorization needs renewing. Repair must use the original account, Home, hub and remote. The app remembers the last email address and sign-in method; passwords and verification codes are not remembered.

Supported single-code commands are imported. Unsupported, ambiguous or multi-code entries may be skipped; the preview reports this. If a command is removed or renamed in BroadLink, check its saved mappings and Flows after refreshing.

### Cloud setup: RM Max

Choose the dedicated **RM Max** driver in Homey. Its two account options are different services:

**Magic Home**

1. Fully configure the RM Max and your remotes in Magic Home. Check that they operate the appliances there.
2. Obtain the official authorization code under **Me / Third-party services** in Magic Home; menu wording may vary.
3. In Homey's RM Max pairing, select **Magic Home**, enter that authorization code and choose the matching region.
4. Find devices, select a remote or sensor and preview its commands or measurements.
5. Add the entry, then repeat for other supported remotes or sensors.

Homey can use only the functions that Magic Home exposes. Standard controls, custom buttons and temperature/humidity measurements depend on the selected entry. If Magic Home exposes only one on/off action for a multi-button RF remote, Homey cannot retrieve the other buttons merely because they are visible in the mobile app.

**BroadLink EU**

Select **BroadLink EU**, sign in with a password or email verification code, select your Home and RM Max, preview the saved commands and add the device. Supported imported IR/RF commands are available through its command Flow card. This RM Max account path has less hardware testing than the reported Magic Home setup.

For both services, learn in the vendor app and use **Refresh saved commands** in Homey afterwards, or wait for the automatic refresh. **Direct learning from Homey is not implemented for the cloud drivers.**

RM Max cloud control does not require successful local authentication. Magic Home control requires the cloud connection. Optional local transport is available only when compatible local credentials are supplied and Homey's local test succeeds; it is not a general RM Max unlock solution.

### Local setup and device locking

For the original local RM drivers, first configure the hub in the official Broadlink app and confirm that it works. Keep Homey and the hub on a network that permits direct communication. A DHCP reservation or fixed IP address is recommended.

Where available, open the device settings in the Broadlink app and disable **Lock device / Device lock** before pairing locally.

[![Example of the Broadlink device-lock setting|390x500](https://us1.discourse-cdn.com/flex025/uploads/athom/original/3X/f/f/ffed901b72ccc9b8f6fa68513ea90826c09244c4.jpeg)](https://us1.discourse-cdn.com/flex025/uploads/athom/original/3X/f/f/ffed901b72ccc9b8f6fa68513ea90826c09244c4.jpeg)

Some models or app versions do not offer this switch. A discovery lock flag alone does not establish whether local control will work. In particular, use the dedicated RM Max cloud setup above when local authentication is rejected.

#### Learning an IR command locally

1. Open the local Broadlink device in Homey and start **Learn IR command**.
2. Point the original remote towards the hub, approximately **10–20 cm** away.
3. Press the required remote button.
4. Wait for confirmation that Homey stored the command, then give it a clear, unique name.

#### Learning an RF command locally

Compatible RM Pro, RM Pro Plus and RM4 Pro devices first detect the remote's frequency through **RF sweeping**. RM4 Pro also offers a manual frequency setting for supported frequencies.

1. Keep the original remote approximately **10–20 cm** from the hub and start **Learn RF command** in Homey.
2. Press and hold the required remote button until Homey requests the next stage or the Broadlink LED indicates that sweeping has completed.
3. Release the button. When prompted for the actual command, briefly press it again.
4. Wait for Homey to confirm that the command was stored.

Do not use only short presses during sweeping. Ordinary fixed-code remotes are the usual candidates; rolling-code or frequency-hopping remotes generally cannot be copied reliably.

### Troubleshooting and support

For pairing, configuration and normal support, please use this topic.

**For local control:** check the current IP address, local-access lock setting where present, network/client isolation and authentication. Firmware can affect local access. Try the current test app and send diagnostics before considering a reset or firmware changes. Cloud support does not require a firmware downgrade.

**For cloud control:** check Internet access, the selected service/account/region and whether the official app can operate the appliance over mobile data. Refresh the saved commands after vendor-app edits. Use Repair when Homey reports an authorization problem.

Each cloud device processes one operation at a time and can hold up to three waiting operations. Rapid presses can therefore show a queue warning. An expired/full queue is reported; failed or uncertain sends are not automatically repeated.

When reporting a problem, include:

* Exact product name, device type/model ID and Broadlink firmware version
* Homey model, Homey firmware and Broadlink Homey app version
* The Homey driver and whether you use local control, BroadLink EU or Magic Home
* Whether the official app works, and which buttons or operations fail
* The displayed error and a precise description of what happens
* For local access, the lock state if known

Send a **Homey diagnostic report immediately after reproducing the problem** and include its report ID. For RF learning, include the complete sweeping and capture attempt. Please do not post passwords, verification/authorization codes or account tokens.

GitHub is for confirmed application bugs and development requests: https://github.com/shaarkys/com.broadlink/issues

Please check for an existing report before opening a new issue.

### Credits

This app builds on several open-source projects and contributors, with development assistance from ChatGPT. Special thanks to the previous developer, [Remko](https://community.homey.app/u/Remko), for his work on the original application. :heavy_heart_exclamation:

* https://github.com/mjg59/python-broadlink
* https://github.com/davorf/BlackBeanControl
* https://github.com/frankjoke/ioBroker.broadlink2
* https://github.com/lprhodes/homebridge-broadlink-rm/tree/master/helpers
* http://peter.windridge.org.uk/playing-with-cheap-iot-devices
* https://blog.ipsumdomus.com/broadlink-smart-home-devices-complete-protocol-hack-bc0b4b397af1

### Support the development

These Homey Community apps are developed and maintained in my spare time. If this app has been useful to you, you can optionally support the development, testing and ongoing maintenance:

**[☕ Support me on Ko-fi](https://ko-fi.com/bretislavkubesa)** · **[❤️ PayPal](https://www.paypal.me/bkubesa)**

Contributions are never required and do not unlock features or affect the support you receive. They are simply a way to say thank you.

### My Homey apps

| App | Purpose |
| --- | --- |
| [Smart Presence](https://homey.app/a/nl.terryhendrix.smartpresence) | Wi-Fi presence detection |
| [Xiaomi Mi Home](https://homey.app/a/com.xiaomi-miio) | Xiaomi Mi Home devices |
| [Broadlink](https://homey.app/a/com.broadlink) | IR, RF and smart devices |
| [TP-Link KASA LAN](https://homey.app/a/nu.baretta.tplink) | Local Kasa control |
| [Yeelights LAN](https://homey.app/a/com.yeelight) | Local Yeelight control |
| [Xiaomi Miija](https://homey.app/a/hu.corenet.mitemp) | Temperature and humidity sensors |
| [Octoprint](https://homey.app/a/no.jonkristian.octoprint) | Monitor your 3D printer |
| [Virtual Radar](https://homey.app/a/com.gruijter.virtualradar) | ADS-B aircraft tracking |
| [enigma2](https://homey.app/a/eu.carp3-noctem.enigma2) | Control Enigma2 receivers |

[**View all my Homey apps →**](https://homey.app/en-us/apps/author/5cc0b0a87a00d60e7682a494/page/0/)
