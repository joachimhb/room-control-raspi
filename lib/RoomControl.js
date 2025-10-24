'use strict';

const _ = require('lodash');

const check = require('check-types-2');

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

  temperatureStatus,
  humidityStatus,

  lightStatus,
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
    check.assert.object(params.tasks, 'params.tasks is not an object');
    check.assert.maybe.object(params.status, 'params.status is not an object');

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

    if(params.tasks.includes('shutters')) {
      for(const shutter of room.shutters || []) {
        const {id, label} = shutter;

        const status = _.get(this.status, ['shutter', id], 0);

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

              // TODO: MOVE TO SMART-HOME
              // if(shutterId && this.shutters[shutterId]) {
              //   if(value === 'closed') {
              //     this.shutters[shutterId].setMax(100);
              //   } else if(value === 'open') {
              //     this.shutters[shutterId].setMax(80);
              //   }
              // }
            }
          });

          this.windows[id].start();
        }
      }
    }

    if(params.tasks.includes('buttons')) {
      for(const button of room.buttons || []) {
        const {id, label, gpio, interval} = button;

        const active = _.get(this.status, ['button', id], true);

        this.buttons[id] = new Button({
          logger,
          location: `${room.label}/${label}`,
          gpio,
          interval,
          onClose: async() => {
            await mqttClient.publish(buttonClose(room.id, id), {}, {retain: true});
          },
          onOpen: async() => {
            await mqttClient.publish(buttonOpen(room.id, id), {}, {retain: true});
          },
        });

        if(active) {
          this.buttons[id].start();
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
}

module.exports = RoomControl;
