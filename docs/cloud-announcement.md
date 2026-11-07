### New cloud support: RM Max, RM3 Mini, RM4 Mini and RM4 Pro

Hi everyone,

The latest **test version** adds cloud control for **RM3 Mini, RM4 Mini and RM4 Pro**, alongside the dedicated **RM Max** integration.

This lets Homey use supported commands already configured in the BroadLink or Magic Home app. It also provides another option where local access is unavailable. **Internet access is required.** Existing local devices and their Flows remain available.

**Install the test version:** https://homey.app/a/com.broadlink/test

### RM3 Mini / RM4 Mini / RM4 Pro: setup

1. Fully configure your hub and appliance remote in the **international BroadLink app**, using an **EU account**. Check that its buttons work there and learn any additional buttons in that app.
2. In Homey, choose **Add device → Broadlink**, then the matching **RM3 Mini (Cloud)**, **RM4 Mini (Cloud)** or **RM4 Pro (Cloud)** driver.
3. Sign in with your BroadLink account email and password. Alternatively, choose **Email verification code**, request a code for your registered account email, check your inbox/spam folder and enter the code.
4. Select your **Home → hub → appliance remote**, then preview its commands. Each appliance remote is added as its own Homey device.
5. Review **Standard controls** and assign the commands you want to use for power, volume, channel or playback.
6. Select up to **12 Additional buttons** for the device view and finish adding the remote.

For a remote with one Power key, use **Power button (toggle)**. For separate On and Off keys, map them separately. This adds Homey's standard on/off control; there is no need to select Power again as an Additional button unless you want an extra raw button too.

The 12-button limit applies to extra buttons in the device view. Navigation, mute and digit keys can be chosen as Additional buttons. **All supported imported commands are available through the command Flow card**, including the other keys on a custom IR/RF remote. RM3/RM4 Mini support IR; RM4 Pro also supports compatible RF commands.

### RM Max: setup

Use Homey's dedicated **RM Max** driver and select the service where the device is configured:

* **Magic Home:** obtain the official authorization code under **Me / Third-party services**, select Magic Home in Homey, enter the code and choose the matching region. Find devices, select a remote or sensor, preview its functions and add it. Repeat for other supported entries.
* **BroadLink EU:** sign in with your account password or an email verification code, select your Home and RM Max, preview the saved commands and add the device.

The available RM Max controls depend on what the selected service exposes. Magic Home may expose fewer buttons than its mobile app shows, particularly for custom RF remotes. Homey can use custom buttons when the service advertises them, but cannot recover buttons that are absent from its API. RM Max Magic Home control has been confirmed by user testing; the BroadLink EU RM Max path has less hardware testing.

### Learning, updates and Repair

* **Learn commands in the vendor app**, then press **Refresh saved commands** in Homey. Homey also refreshes approximately every **five minutes**. Direct learning from Homey is not implemented for these cloud drivers.
* On the RM3/RM4 cloud devices, use **Repair → Change controls** to edit mappings and visible buttons without signing in again. Use **Sign in again** to renew authorization for the same account, Home, hub and remote.
* The last account email and sign-in method are preselected for subsequent pairing and Repair. Passwords and verification codes are not remembered. Native Google/Apple sign-in buttons are not provided.
* The cloud connection is checked automatically. Temporary failures schedule recovery checks; rejected authorization requires Repair.
* Rapid presses can fill the bounded command queue. Failed or uncertain sends are not automatically repeated. A cloud acknowledgement and the displayed power value do not measure the appliance's actual state.

Recent user logs show successful RM4 Mini refreshes and RM4 Pro pairing, imports and command acknowledgements. Please help test other supported models and firmware versions as well.

If you find a problem, post the exact model, firmware, cloud service, failing operation and error message here. Please send a **Homey diagnostic report immediately afterwards** and include its report ID. Do not post login codes, authorization codes or tokens.

Thanks to Ruud and everyone who helped with testing and diagnostics!

If you would like to support the time spent developing and maintaining this app, you can buy me a coffee here:

**[☕ Support the development on Ko-fi](https://ko-fi.com/bretislavkubesa)**

Contributions are optional and do not affect features or support.

Břetislav
