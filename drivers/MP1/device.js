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


class MP1Device extends BroadlinkDevice {


	async generate_trigger(sid, mode) {
		let capa = 'onoff.s' + sid
		if (mode != this.getCapabilityValue(capa)) {
			let drv = this.driver;
			await Promise.all([
				drv.trigger_toggle.trigger(this, {}, { "switchID": sid }),
				(mode ? drv.trigger_on : drv.trigger_off).trigger(this, {}, { "switchID": sid }),
			]);
		}
	}


	/**
	 * Send 'on/off' command to the device.
	 *
	 * @param sid  [string] "1".."4"
	 * @param mode [boolean] true, false
	 */
	async set_onoff(sid, mode) {
		try {
			await this._communicate.mp1_set_power_state(sid, mode)
		} catch (e) {
			this.error('Error setting MP1 power state', e);
			throw e;
		}
		try {
			await this.generate_trigger(sid, mode);
		} catch (err) {
			this.error('MP1 command acknowledged; Homey Flow trigger failed', err);
		}
		try {
			await this.setCapabilityValue('onoff.s' + sid, mode);
		} catch (err) {
			this.error('MP1 command acknowledged; Homey capability update failed', err);
		}
	}


	/**
	 * Returns the power state of the smart power strip.
	 */
	async onCheckInterval() {
		const generation = this._localGeneration;
		const communication = this._communicate;
		const active = () => !this._localStopped && generation === this._localGeneration && communication === this._communicate;
		if (!active()) return;
		try {
			let state = await communication.mp1_check_power();
			if (!active()) return;
			let s1, s2, s3, s4;
			s1 = (state & 0x01) ? true : false;
			s2 = (state & 0x02) ? true : false;
			s3 = (state & 0x04) ? true : false;
			s4 = (state & 0x08) ? true : false;

			await Promise.all([
				this.generate_trigger('1', s1),
				this.generate_trigger('2', s2),
				this.generate_trigger('3', s3),
				this.generate_trigger('4', s4),
			]).catch((err) => this.error('MP1 state read succeeded; Homey Flow trigger failed', err));
			if (!active()) return;
			await this.setCapabilityValue('onoff.s1', s1);
			if (!active()) return;
			await this.setCapabilityValue('onoff.s2', s2);
			if (!active()) return;
			await this.setCapabilityValue('onoff.s3', s3);
			if (!active()) return;
			await this.setCapabilityValue('onoff.s4', s4);

		} catch (e) {
			if (active()) this.error('MP1 state polling failed', e);
		}
	}

	check_condition_on(sid) {
		let capa = 'onoff.s' + sid
		let onoff = this.getCapabilityValue(capa)
		return Promise.resolve(onoff)
	}

	async do_action_on(sid) {
		await this.set_onoff(sid, true);
		return true;
	}

	async do_action_off(sid) {
		await this.set_onoff(sid, false);
		return true;
	}

	onCapabilityOnOff_1(mode) { return this.set_onoff("1", mode); }
	onCapabilityOnOff_2(mode) { return this.set_onoff("2", mode); }
	onCapabilityOnOff_3(mode) { return this.set_onoff("3", mode); }
	onCapabilityOnOff_4(mode) { return this.set_onoff("4", mode); }

	async onInit() {
		this.stop_check_interval();
		if (await super.onInit() === false || this._localStopped) return false;
		this._utils.debugLog(this, "MP1 Device onInit called");
		this.registerCapabilityListener('onoff.s1', this.onCapabilityOnOff_1.bind(this))
		this.registerCapabilityListener('onoff.s2', this.onCapabilityOnOff_2.bind(this))
		this.registerCapabilityListener('onoff.s3', this.onCapabilityOnOff_3.bind(this))
		this.registerCapabilityListener('onoff.s4', this.onCapabilityOnOff_4.bind(this))
		this.start_check_interval(this.getSettings().CheckInterval || 5);
	}

	async onSettings({ newSettings, changedKeys }) {
		if (changedKeys.includes('ipAddress')) this._communicate.setIPaddress(newSettings.ipAddress);
		if (changedKeys.includes('CheckInterval')) {
			this.stop_check_interval();
			this.start_check_interval(newSettings.CheckInterval);
		}
	}

}

module.exports = MP1Device;
