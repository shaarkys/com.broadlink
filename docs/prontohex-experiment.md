# Broadlink to Homey Pronto Hex experiment

This experimental feature converts an IR command already learned by a Broadlink RM into raw Pronto Hex for testing with Homey's built-in infrared transmitter.

## Expected behaviour

- Only stored Broadlink IR packets (`0x26`) can be converted. RF and unknown packet types are rejected.
- Broadlink learned data contains pulse timings but not the original IR carrier frequency.
- The converter therefore assumes 38 kHz by default, matching the documented Broadlink RM carrier.
- A different carrier can be entered for testing. Values outside Homey's documented 30-45 kHz app-signal range, such as 56 kHz, remain experimental.
- The complete learned timing sequence is preserved. The converter does not silently remove possible repeated frames.
- The generated Pronto Hex is a raw one-shot command (`0000`) with no separate Pronto repeat section.
- Homey repetitions should initially be set to `1` to avoid combining captured repeats with additional Homey repetitions.

## Test procedure

1. Install or run the app from the `test/prontohex-conversion` branch.
2. Open the Broadlink app settings and find **Learned command manager**.
3. Select the RM device and refresh its learned commands.
4. Leave the carrier at `38000` Hz for the first comparison.
5. Select **Pronto Hex** next to a learned IR command and copy the generated code.
6. In a Flow, add **System → Send infrared**, paste the code and set repetitions to `1`.
7. Trigger the Flow and compare the result with replaying the same command through the Broadlink device.
8. For a command believed to use another carrier, generate a second code with that frequency and test it separately. For the KPN/CanalSatLD experiment, use `56000` Hz.

## Useful test report

For each tested command, record:

- Broadlink model and Homey model
- Command name and controlled device
- Whether Broadlink replay works
- Selected Pronto carrier
- Whether Homey replay works
- Whether the action occurs once, more than once, or not at all
- Any warning shown by the converter

Do not compare different carrier outputs by changing Homey repetitions at the same time. Start with repetitions `1` for every carrier so only one variable changes.
