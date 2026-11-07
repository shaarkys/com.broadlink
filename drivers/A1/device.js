/**
 * Driver for Broadlink devices
 *
 * Copyright 2018-2019, R Wensveen
 *
 * This file is part of com.broadlink
 * com.broadlink is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * com.broadlink is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * You should have received a copy of the GNU General Public License
 * along with com.broadlink.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const BroadlinkDevice = require('./../../lib/BroadlinkDevice');


/*
 * NOTE: these values should match the enums in app.json
 */
var AirQualityLevel = Object.freeze({
	excellent: { value: 1, name: 'excellent' },
	good: { value: 2, name: 'good' },
	normal: { value: 3, name: 'normal' },
	bad: { value: 4, name: 'bad' },
	unknown: { value: 11, name: 'unknown' }
})
var LightLevel = Object.freeze({
	dark: { value: 1, name: 'dark' },
	dim: { value: 2, name: 'dim' },
	normal: { value: 3, name: 'normal' },
	bright: { value: 4, name: 'bright' },
	unknown: { value: 11, name: 'unknown' }
})
var NoiseLevel = Object.freeze({
	quiet: { value: 1, name: 'quiet' },
	normal: { value: 2, name: 'normal' },
	noisy: { value: 3, name: 'noisy' },
	unknown: { value: 11, name: 'unknown' }
})


class A1Device extends BroadlinkDevice {


	async onInit() {
		this.stop_check_interval();
		if (await super.onInit() === false || this._localStopped) return false;
		this.registerCapabilityListener('updateSensor', this.onCapabilityUpdateSensor.bind(this));
		this.air_quality = AirQualityLevel.unknown.value;
		this.light_level = LightLevel.unknown.value;
		this.noise_level = NoiseLevel.unknown.value;
		this.start_check_interval(this.getSettings().CheckInterval || 5);
	}


	onCapabilityUpdateSensor(onoff) {
		return this.onCheckInterval();
	}


	getAirQualityList(mode) {
		if (mode == 'better') {
			return [
				{ name: this.homey.__('air_quality.good'), value: AirQualityLevel.good.value },
				{ name: this.homey.__('air_quality.normal'), value: AirQualityLevel.normal.value },
				{ name: this.homey.__('air_quality.bad'), value: AirQualityLevel.bad.value }
			];
		}
		if (mode == 'worse') {
			return [
				{ name: this.homey.__('air_quality.excellent'), value: AirQualityLevel.excellent.value },
				{ name: this.homey.__('air_quality.good'), value: AirQualityLevel.good.value },
				{ name: this.homey.__('air_quality.normal'), value: AirQualityLevel.normal.value }
			];
		}
		return [
			{ name: this.homey.__('air_quality.excellent'), value: AirQualityLevel.excellent.value },
			{ name: this.homey.__('air_quality.good'), value: AirQualityLevel.good.value },
			{ name: this.homey.__('air_quality.normal'), value: AirQualityLevel.normal.value },
			{ name: this.homey.__('air_quality.bad'), value: AirQualityLevel.bad.value }
		];
	}

	check_airquality_level(args, state) {
		return Promise.resolve(args.variable.value == args.device.air_quality)
	}

	check_airquality_level_better(args, state) {
		return Promise.resolve(args.variable.value > args.device.air_quality)
	}

	check_airquality_level_worse(args, state) {
		return Promise.resolve(args.variable.value < args.device.air_quality)
	}


	getLightLevelList(mode) {
		if (mode == 'brighter') {
			return [
				{ name: this.homey.__('light_level.dark'), value: LightLevel.dark.value },
				{ name: this.homey.__('light_level.dim'), value: LightLevel.dim.value },
				{ name: this.homey.__('light_level.normal'), value: LightLevel.normal.value }
			];
		}
		if (mode == 'darker') {
			return [
				{ name: this.homey.__('light_level.dim'), value: LightLevel.dim.value },
				{ name: this.homey.__('light_level.normal'), value: LightLevel.normal.value },
				{ name: this.homey.__('light_level.bright'), value: LightLevel.bright.value }
			];
		}
		return [
			{ name: this.homey.__('light_level.dark'), value: LightLevel.dark.value },
			{ name: this.homey.__('light_level.dim'), value: LightLevel.dim.value },
			{ name: this.homey.__('light_level.normal'), value: LightLevel.normal.value },
			{ name: this.homey.__('light_level.bright'), value: LightLevel.bright.value }
		];
	}

	check_lightlevel(args, state) {
		return Promise.resolve(args.variable.value == args.device.light_level)
	}

	check_lightlevel_brighter(args, state) {
		return Promise.resolve(args.variable.value < args.device.light_level)
	}

	check_lightlevel_darker(args, state) {
		return Promise.resolve(args.variable.value > args.device.light_level)
	}


	getNoiseLevelList(mode) {
		if (mode == 'louder') {
			return [
				{ name: this.homey.__('noise_level.quiet'), value: NoiseLevel.quiet.value },
				{ name: this.homey.__('noise_level.normal'), value: NoiseLevel.normal.value }
			];
		}
		if (mode == 'softer') {
			return [
				{ name: this.homey.__('noise_level.normal'), value: NoiseLevel.normal.value },
				{ name: this.homey.__('noise_level.noisy'), value: NoiseLevel.noisy.value }
			];
		}
		return [
			{ name: this.homey.__('noise_level.quiet'), value: NoiseLevel.quiet.value },
			{ name: this.homey.__('noise_level.normal'), value: NoiseLevel.normal.value },
			{ name: this.homey.__('noise_level.noisy'), value: NoiseLevel.noisy.value }
		];
	}

	check_noiselevel(args, state) {
		return Promise.resolve(args.variable.value == args.device.noise_level);
	}

	check_noiselevel_softer(args, state) {
		return Promise.resolve(args.variable.value > args.device.noise_level);
	}

	check_noiselevel_louder(args, state) {
		return Promise.resolve(args.variable.value < args.device.noise_level);
	}


	/**
	 * Called when the periodic timer expires
	 */
	async onCheckInterval() {
		const generation = this._localGeneration;
		const communication = this._communicate;
		const active = () => !this._localStopped && generation === this._localGeneration && communication === this._communicate;
		if (!active()) return;
		try {
			let response = await communication.read_status();
			if (!active()) return;

			let temperature = (response[0] * 10 + response[1]) / 10.0;
			let humidity = (response[2] * 10 + response[3]) / 10.0;
			let str_light = response[4];
			let str_air_quality = response[6];
			let str_noise = response[8];

			let curr_air_quality = this.air_quality;
			let curr_light = this.light_level;
			let curr_noise = this.noise_level;
			let curr_temperature = this.temperature;
			let curr_humidity = this.humidity;

			switch (str_air_quality) {
				case 0: this.air_quality = AirQualityLevel.excellent.value; str_air_quality = AirQualityLevel.excellent.name; break;
				case 1: this.air_quality = AirQualityLevel.good.value; str_air_quality = AirQualityLevel.good.name; break;
				case 2: this.air_quality = AirQualityLevel.normal.value; str_air_quality = AirQualityLevel.normal.name; break;
				case 3: this.air_quality = AirQualityLevel.bad.value; str_air_quality = AirQualityLevel.bad.name; break;
				default: this.air_quality = AirQualityLevel.unknown.value; str_air_quality = AirQualityLevel.unknown.name; break;
			}
			if (this.air_quality != AirQualityLevel.unknown.value) {
				await this.setCapabilityValue('a1_air_quality', str_air_quality, true);
				if (!active()) return;
				await this.setCapabilityValue('a1_air_quality_number', this.air_quality);
				if (!active()) return;
			}

			switch (str_light) {
				case 0: this.light_level = LightLevel.dark.value; str_light = LightLevel.dark.name; break;
				case 1: this.light_level = LightLevel.dim.value; str_light = LightLevel.dim.name; break;
				case 2: this.light_level = LightLevel.normal.value; str_light = LightLevel.normal.name; break;
				case 3: this.light_level = LightLevel.bright.value; str_light = LightLevel.bright.name; break;
				default: this.light_level = LightLevel.unknown.value; str_light = LightLevel.unknown.name; break;
			}
			if (this.light_level != LightLevel.unknown.value) {
				await this.setCapabilityValue('a1_light_level', str_light, true);
				if (!active()) return;
				await this.setCapabilityValue('a1_light_level_number', this.light_level);
				if (!active()) return;
			}

			switch (str_noise) {
				case 0: this.noise_level = NoiseLevel.quiet.value; str_noise = NoiseLevel.quiet.name; break;
				case 1: this.noise_level = NoiseLevel.normal.value; str_noise = NoiseLevel.normal.name; break;
				case 2: this.noise_level = NoiseLevel.noisy.value; str_noise = NoiseLevel.noisy.name; break;
				default: this.noise_level = NoiseLevel.unknown.value; str_noise = NoiseLevel.unknown.name; break;
			}
			if (this.noise_level != NoiseLevel.unknown.value) {
				await this.setCapabilityValue('a1_noise_level', str_noise, true);
				if (!active()) return;
				await this.setCapabilityValue('a1_noise_level_number', this.noise_level);
				if (!active()) return;
			}

			await this.setCapabilityValue('measure_temperature', temperature);
			if (!active()) return;
			await this.setCapabilityValue('measure_humidity', humidity);
			if (!active()) return;

			let drv = this.driver;
			if (curr_air_quality != this.air_quality) { await drv.a1_trigger_air_quality.trigger(this, { 'airquality': str_air_quality }, {}) }
			if (!active()) return;
			if (curr_light != this.light_level) { await drv.a1_trigger_light_level.trigger(this, { 'lightlevel': str_light }, {}) }
			if (!active()) return;
			if (curr_noise != this.noise_level) { await drv.a1_trigger_noise_level.trigger(this, { 'noiselevel': str_noise }, {}) }

		} catch (e) {
			this._utils.debugLog(this, '**> A1.onCheckInterval: ' + e);
		}

	}

	async onSettings({ oldSettings, newSettings, changedKeys }) {
		if (changedKeys.length > 0) {

			try {
				this._utils.debugLog(this, 'Settings changed:', changedKeys);

				for (const key of changedKeys) {
					this._utils.debugLog(this, `Changed setting key: ${key}, Old value: ${oldSettings[key]}, New value: ${newSettings[key]}`);

					if (key === 'ipAddress' && newSettings.ipAddress) {
						this._utils.debugLog(this, `Updating IP address to ${newSettings.ipAddress}`);
						this._communicate.setIPaddress(newSettings.ipAddress);
					}
					if (key === 'CheckInterval' && newSettings.CheckInterval) {
						this._utils.debugLog(this, `Updating CheckInterval to ${newSettings.CheckInterval}`);
						this.stop_check_interval();
						this.start_check_interval(newSettings.CheckInterval);
					}
					if (key === 'Authenticate' && newSettings.Authenticate) {
						this._utils.debugLog(this, "Re-authenticating device due to settings change");
						let deviceData = this.getData();
						let options = {
						  ipAddress: newSettings.ipAddress,
						  mac: this._utils.hexToArr(deviceData.mac),
						  count: Math.floor(Math.random() * 0xffff),
						  id: null,
						  key: null,
						  homey: this.homey,
						  deviceType: Number(deviceData.devtype),
						};
						this._communicate.configure(options);
						await this.authenticateDevice();
					}
				}
			} catch (err) {
				this._utils.debugLog(this, 'Error handling settings change: ', err);
				throw new Error('Settings could not be updated: ' + err.message);
			}
			this.log('Broadlink settings changed:\n', changedKeys);
		}
		else {
			this.log('No settings were changed');

		}
	}


}

module.exports = A1Device;
