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


class SP1Device extends BroadlinkDevice {


	async generate_trigger(mode) {
		if (mode != this.getCapabilityValue('onoff')) {
			let drv = this.driver;
			await Promise.all([
				drv.trigger_toggle.trigger(this, {}, {}),
				(mode ? drv.trigger_on : drv.trigger_off).trigger(this, {}, {}),
			]);
		}
	}

	async set_onoff(mode) {
		try {
			await this._communicate.sp1_set_power_state(mode)
        } catch (e) {
            this.error('Error in set_onoff', e);
			throw e;
        }
		try {
			await this.generate_trigger(mode);
		} catch (err) {
			this.error('SP1 command acknowledged; Homey Flow trigger failed', err);
		}
		try {
			await this.setCapabilityValue('onoff', mode);
		} catch (err) {
			this.error('SP1 command acknowledged; Homey capability update failed', err);
		}
	}

	check_condition_on() {
		let onoff = this.getCapabilityValue('onoff')
		return Promise.resolve(onoff)
	}

	async do_action_on() {
		await this.set_onoff(true);
		return true;
	}

	async do_action_off() {
		await this.set_onoff(false);
		return true;
	}

	onCapabilityOnOff(mode) {
		return this.set_onoff(mode);
	}

	async onInit() {
		if (await super.onInit() === false || this._localStopped) return false;
		this._utils.debugLog(this, "SP1 Device onInit called");
		this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
	}
}

module.exports = SP1Device;
