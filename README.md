# Homey

Use [Homey](https://www.athom.com/) together with [Broadlink devices](http://www.ibroadlink.com/).

# Supported devices

* [A1](http://www.ibroadlink.com/a1/) - Environment Sensor
* [RM3 mini](http://www.ibroadlink.com/rmMini3/)
  The RM3 Mini is a wifi to IR (infrared) device. It can learn IR commands and transmit them.
* [RM Pro](http://www.ibroadlink.com/rmPro)  - IR
* [RM Pro Plus](http://www.ibroadlink.com/rmPro+)   - IR + RF
* RM4 Pro - IR + RF
* [RM3 Mini / RM4 Mini / RM4 Pro / RM5 Plus (Cloud)](docs/rm-cloud.md) - separate EU-account drivers for saved appliance remotes, configurable controls and command refresh; physical cloud control still requires model testing
* [RM Max](docs/RM-Max-cloud.md) - BroadLink EU saved IR/RF commands and optional tested local credentials; Magic Home advertised remote controls and temperature/humidity sensors, automatic cloud refresh and connection recovery
* SP1  - power socket switch
* SP2  - power socket switch with nightlight and meter
* SP3S - power socket switch with meter
* MP1 - 4 way power socket switch
* Hysen - thermostat. this is an oem device, also available with other brandnames,
           such as [Beok](http://www.beok-controls.com/product.asp)
* Dooya - [motorized curtain](http://en.dooya.com/products_3.html)

Others might follow...

BroadLink EU cloud drivers also support [email verification-code sign-in and Repair](docs/email-code-sign-in.md).

# Debug and Error log

In the application settings, there are 2 flags to enable logging: Debug and Sentry.
* Debug logging dumps messages via the console log. This only works if the app is
  started in debug mode from a PC (using 'athom app run --remote')
* Sentry is currently disabled

# Reference

This app is based on the hard work of other people.

See:
* <https://github.com/mjg59/python-broadlink>
* <https://github.com/davorf/BlackBeanControl>
* <https://github.com/frankjoke/ioBroker.broadlink2>
* <https://github.com/lprhodes/homebridge-broadlink-rm/tree/master/helpers>
* <http://peter.windridge.org.uk/playing-with-cheap-iot-devices>  (hysen thermostat)

Protocol:
* <https://blog.ipsumdomus.com/broadlink-smart-home-devices-complete-protocol-hack-bc0b4b397af1>

# NodeJS modules

requires the following NodeJS modules
* dgram
* crc

# app.json

app.json is split in serveral files (driver.compose.json et all).
In order to create a full app.json, open a commandline (i.e. terminal):

 > cd com.broadlink
 > athom app validate

# Version

See <https://homey.app/en-us/app/com.broadlink/Broadlink/> for Changelog

## Support development

If this integration is useful to you, you can optionally support my ongoing development and maintenance:

- [GitHub Sponsors](https://github.com/sponsors/shaarkys)
- [Ko-fi](https://ko-fi.com/bretislavkubesa)
- [PayPal](https://www.paypal.com/paypalme/bkubesa)

Contributions are appreciated, never required, and do not affect features or support.
