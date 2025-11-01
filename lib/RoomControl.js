'use strict';

const _ = require('lodash');

const check       = require('check-types-2');
const millisecond = require('millisecond');
const moment      = require('moment');
const prettyMs    = require('pretty-ms');

const {
  sensors,
  controls,
} = require('@joachimhb/smart-home-raspi-access');

const {
  topics,
} = require('@joachimhb/smart-home-common');

const {
  shutterMovement,
  shutterStatus,
  windowStatus,

  buttonClose,
  buttonOpen,
  buttonStatus,

  temperatureStatus,
  humidityStatus,

  lightStatus,

  fanSpeed,
} = topics;

const {
  Shutter,
  Button,
  Fan,
} = controls;

const {
  IntervalCircuit,
  DHT22,
  Light,
} = sensors;

class RoomControl {
  constructor(params) {
    check.assert.object(params, 'params is not an object');
    check.assert.object(params.logger, 'params.logger is not an object');
    check.assert.object(params.mqttClient, 'params.mqttClient is not an object');
    check.assert.object(params.room, 'params.room is not an object');
    check.assert.array(params.tasks, 'params.tasks is not an array');
    check.assert.function(params.getStatus, 'params.getStatus is not an object');

    Object.assign(this, params);

    const {room, logger, mqttClient} = this;

    this.shutters     = {};
    this.buttons      = {};
    this.windows      = {};
    this.lights       = {};
    this.fans         = {};
    this.dht22        = {};

    this.temperatures = {};
    this.humidities   = {};

    this.fansTrailing = {};

    if(params.tasks.includes('shutters')) {
      for(const shutter of room.shutters || []) {
        const {id, label} = shutter;

        const status = _.get(this.getStatus(), ['shutter', id], 0);

        this.shutters[shutter.id] = new Shutter({
          logger,
          location: `${room.label}/${label}`,
          ...shutter,
          status,
          onStatusUpdate: async value => {
            await mqttClient.publish(shutterStatus(room.id, id), {value}, {retain: true});
          },
          onMovementUpdate: async value => {
            await mqttClient.publish(shutterMovement(room.id, id), {value}, {retain: true});
          },
        });
      }
    }

    if(params.tasks.includes('windows')) {
      for(const window of room.windows || []) {
        const {id, label, gpio, interval} = window;

        if(gpio) {
          this.windows[id] = new IntervalCircuit({
            logger,
            location: `${room.label}/${label}`,
            default: 'closed',
            gpio: gpio,
            interval,
            onChange: async value => {
              await mqttClient.publish(windowStatus(room.id, id), {value}, {retain: true});
            },
          });

          this.windows[id].start();
        }
      }
    }

    if(params.tasks.includes('buttons')) {
      for(const button of room.buttons || []) {
        const {id, label, gpio, interval, onClose, onOpen} = button;

        const active = _.get(this.getStatus(), ['button', id], true);

        this.buttons[id] = new Button({
          logger,
          location: `${room.label}/${label}`,
          gpio,
          interval,
          onClose: async() => {
            await mqttClient.publish(buttonClose(room.id, id));
            await mqttClient.publish(buttonStatus(room.id, id), {value: 'closed'}, {retain: true});

            if(onClose) {
              const {action, actionParams} = onClose;

              if(topics[action]) {
                await mqttClient.publish(topics[action](...actionParams));
              }
            }
          },
          onOpen: async() => {
            await mqttClient.publish(buttonOpen(room.id, id));
            await mqttClient.publish(buttonStatus(room.id, id), {value: 'open'}, {retain: true});

            if(onOpen) {
              const {action, actionParams} = onOpen;

              if(topics[action]) {
                await mqttClient.publish(topics[action](...actionParams));
              }
            }
          },
        });

        if(active) {
          this.buttons[id].start();
        } else {
          this.logger.warn(`${this.buttons[id]} is not active`);
        }
      }
    }

    if(params.tasks.includes('dht22')) {
      for(const dht22 of room.dht22 || []) {
        const {id, label} = dht22;

        this.dht22[id] = new DHT22({
          logger,
          location: `${room.label}/${label}`,
          ...dht22,
          onHumidityChange: async value => {
            await mqttClient.publish(humidityStatus(room.id, id), {value}, {retain: true});
          },
          onTemperatureChange: async value => {
            await mqttClient.publish(temperatureStatus(room.id, id), {value}, {retain: true});
          },
        });

        this.dht22[id].start();
      }
    }

    if(params.tasks.includes('fans')) {
      for(const fan of room.fans || []) {
        this.fans[fan.id] = new Fan({
          logger,
          location: `${room.label}/${fan.label}`,
          ...fan,
        });
      }

      setInterval(() => {
        this.updateFans();
      }, 10000);
    }

    if(params.tasks.includes('lights')) {
      for(const light of room.lights || []) {
        this.lights[light.id] = new Light({
          logger,
          location: `${room.label}/${light.label}`,
          ...light,
          onChange: async value => {
            await mqttClient.publish(lightStatus(room.id, light.id), {value}, {retain: true});
          },
        });

        this.lights[light.id].start();
      }
    }
  }

  shutter(action, id, value) {
    if(this.shutters[id]) {
      if(action === 'max') {
        this.shutters[id].setMax(value);
      } else {
        this.shutters[id][action]();
      }
    }
  }

  button(action, id, value) {
    if(action === 'active') {
      if(this.buttons[id]) {
        if(value) {
          this.buttons[id].start();
        } else {
          this.buttons[id].stop();
        }
      }
    }
  }

  fan() {
    this.updateFans();
  }

  async updateFans() {
    const {room, logger, fansTrailing, mqttClient} = this;

    const {mainHumidity} = room;

    const status = this.getStatus();

    console.log(JSON.stringify(status, null, 2));

    for(const fan of room.fans || []) {
      const location = `${room.label}/${fan.label}`;
      const humidity = _.get(status, ['humidity', mainHumidity.id, 'status', 'value']);

      const minHumidityThreshold = _.get(status, ['fan', fan.id, 'minHumidityThreshold', 'value'], fan.minHumidityThreshold);
      const maxHumidityThreshold = _.get(status, ['fan', fan.id, 'maxHumidityThreshold', 'value'], fan.maxHumidityThreshold);

      const minRunTime   = _.get(status, ['fan', fan.id, 'minRunTime', 'value'], fan.minRunTime);
      const lightTimeout = _.get(status, ['fan', fan.id, 'lightTimeout', 'value'], fan.lightTimeout);
      const trailingTime = _.get(status, ['fan', fan.id, 'trailingTime', 'value'], fan.trailingTime);

      const control    = _.get(status, ['fan', fan.id, 'control', 'value'], 'manual');
      const speed      = _.get(status, ['fan', fan.id, 'speed', 'value'], 'off');
      const speedSince = _.get(status, ['fan', fan.id, 'speed', 'since'], new Date());

      this.logger.debug(`updateFans ${location}`, JSON.stringify(_.get(status, ['fan', fan.id]), null, 2), {humidity});

      if(control === 'manual') {
        this.fans[fan.id][speed]();

        continue;
      }

      // fan should run at same speed for a minimum time
      if(speed !== 'off' && moment().diff(speedSince, 'millisecond') < millisecond(`${minRunTime}s`)) {
        logger.debug(`[${location}]:Keep running - ${minRunTime}s not reached`);

        continue;
      }

      // automatic handling

      let newSpeed = 'off';

      if(humidity) {
        const downToMinThreshold = minHumidityThreshold - 5;
        const downToMaxThreshold = maxHumidityThreshold - 10;

        if(humidity > maxHumidityThreshold) {
          newSpeed = 'max';
          logger.warn(`[${location}]: Fan - run [max] - humidity > ${maxHumidityThreshold}`);
        } else if(speed === 'max' && humidity > downToMaxThreshold) {
          newSpeed = 'max';
          // just wait...
          logger.warn(`[${location}]: Fan - keep running [max] - humidity > ${downToMaxThreshold}`);
        } else if(humidity > minHumidityThreshold) {
          newSpeed = 'min';
          logger.warn(`[${location}]: Fan - run [min] - humidity > ${minHumidityThreshold}`);
        } else if(speed === 'min' && humidity > downToMinThreshold) {
          newSpeed = 'min';
          // just wait...
          logger.warn(`[${location}]: Fan - keep running [min] - humidity > ${downToMinThreshold}`);
        }
      }

      let minLightOnSince = null;
      let maxLightOffSince = null;
      let anyLightOn = false;

      for(const lightId of fan.triggerLights || []) {
        const lightValue = _.get(status, ['light', lightId, 'status', 'value']);
        const since = _.get(status, ['light', lightId, 'status', 'since']);

        console.log(lightId, {lightValue, since});

        if(lightValue === 'on') {
          if(!minLightOnSince || since < minLightOnSince) {
            minLightOnSince = since;
          }

          anyLightOn = true;
        } else if(!maxLightOffSince || since > maxLightOffSince) {
          maxLightOffSince = since;
        }
      }

      if(anyLightOn && minLightOnSince) {
        const lightsOnDuration = moment().diff(minLightOnSince, 'millisecond');

        logger.debug(`[${location}]:Light(s) on since ${prettyMs(lightsOnDuration)}`);

        if(lightsOnDuration > millisecond(`${lightTimeout}s`)) {
          logger.debug(`[${location}]:Light timeout of ${lightTimeout}s reached`);

          fansTrailing[fan.id] = true;
        }
      }

      if(!anyLightOn && fansTrailing[fan.id] && maxLightOffSince) {
        const lightsOffDuration = moment().diff(maxLightOffSince, 'millisecond');

        logger.debug(`[${location}]:Light(s) off since ${prettyMs(lightsOffDuration)}`);

        if(lightsOffDuration > millisecond(`${trailingTime}s`)) {
          logger.debug(`[${location}]:Trailing time of ${trailingTime}s reached`);

          fansTrailing[fan.id] = false;
        } else {
          logger.debug(`[${location}]:Keep trailing - trailing time of ${trailingTime}s not yet reached`);
        }
      }

      if(fansTrailing[fan.id]) {
        newSpeed = 'min';
      }

      if(speed !== newSpeed) {
        await mqttClient.publish(fanSpeed(room.id, fan.id), {value: newSpeed}, {retain: true});
      }

      this.fans[fan.id][newSpeed]();
    }
  }
}

module.exports = RoomControl;
