# Using a learned Broadlink IR command with Homey

The app can convert an infrared command learned by a Broadlink RM into Pronto Hex. The generated code can then be sent through the infrared transmitter built into a supported Homey Pro.

This is useful when the Broadlink can learn a remote control command, but Homey is better positioned to transmit it to the controlled device.

## Before converting

- First confirm that the Broadlink RM can learn and replay the IR command successfully.
- Only learned infrared commands can be converted. RF commands are rejected.
- Broadlink stores the pulse timings, but not the original carrier frequency. The converter therefore uses an assumed carrier frequency.

## Carrier frequency

The carrier field is in the Broadlink app settings under **Learned command manager**, directly below the RM device selector and above the learned-command list. It is labelled **Pronto carrier (Hz)**.

The value in this field is used when you press **Pronto Hex** next to a learned command:

- Keep the default value of `38000` Hz for the first test.
- Change it only when the carrier frequency used by the controlled device is known. For example, enter `56000` to test a device known to use a 56 kHz carrier.
- Generate the Pronto Hex again after changing the value. An already generated code is not changed automatically.
- The field accepts values from `10000` to `100000` Hz. Homey documents a 30-45 kHz range for IR signals defined by apps. This test sends Pronto Hex through Homey's System Flow card, but operation outside that documented range is not guaranteed. Values such as `56000` are therefore experimental.

## Test procedure

1. Open the Broadlink app settings and locate **Learned command manager**.
2. Select the Broadlink RM device containing the learned command.
3. If necessary, select **Refresh commands**.
4. Set **Pronto carrier (Hz)** to `38000` for the first test.
5. Select **Pronto Hex** next to the learned IR command.
6. Select **Copy Pronto Hex**.
7. In a Homey Flow, add **System → Send infrared**.
8. Paste the generated code and set **repetitions** to `1`.
9. Trigger the Flow and check whether Homey performs the same action as the Broadlink replay.

The complete learned timing sequence is retained during conversion. Because a capture may already contain repeated frames, always start with one Homey repetition.

## Useful test report

Please report only the result of these three stages:

1. **Learn:** Did the Broadlink learn the command and replay it successfully?
2. **Convert:** Was Pronto Hex generated successfully, and which carrier value was selected?
3. **Send:** Did **System → Send infrared** work with repetitions set to `1`? State whether the action occurred once, multiple times or not at all.

If the conversion fails or the result is uncertain, create a diagnostic report for the Broadlink app using Homey's standard app diagnostic functionality. Perform the learn, convert and Homey-send test shortly before creating the report so the relevant entries are present.
