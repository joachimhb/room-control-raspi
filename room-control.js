'use strict';

const _            = require('lodash');
const check        = require('check-types-2');
const fs           = require('fs-extra');
const log4js       = require('log4js');
const rpio         = require('rpio');
const pigpio       = require('pigpio');
const {processenv} = require('processenv');

const RoomControl = require('./lib/RoomControl.js');

const {
  MqttClient,
  topics,
} = require('@joachimhb/smart-home-common');

const {
  shutterUp,
  shutterDown,
  shutterStop,
  shutterStatus,
  shutterToggle,
  shutterMax,
  windowStatus,
  lightStatus,

  buttonActive,
  buttonStatus,

  temperatureStatus,
  humidityStatus,

  automationInit,
} = topics;

const shutdown = function() {
  pigpio.terminate();
  console.log('Terminating...');
  process.exit(0);
};

process.on('SIGHUP', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGCONT', shutdown);
process.on('SIGTERM', shutdown);

rpio.init({mapping: 'gpio'});

const logger = log4js.getLogger();

logger.level = 'info';
logger.level = 'debug';
// logger.level = 'trace';

const lockFilePath = '/var/run/pigpio.pid';

try {
  // eslint-disable-next-line no-sync
  const stats = fs.statSync(lockFilePath);

  if(stats) {
    // eslint-disable-next-line no-sync
    fs.unlinkSync(lockFilePath);

    logger.warn(`Deleted lockfile [${lockFilePath}]`);
  }
} catch(err) {
  if(err.code !== 'ENOENT') {
    logger.error(`Failed to cleanup lockfile [${lockFilePath}]`, err);
  }
}

const configPath = processenv('SMART_HOME_CONFIG_PATH', '../smart-home-setup/shared/config.js');
const tasksString = processenv('SMART_HOME_TASKS', 'wohnzimmer:shutters,wohnzimmer:dht22,wohnzimmer:windows');
const raspi = processenv('SMART_HOME_RASPI', 'wohnzimmer');

logger.info(`INIT: ${raspi} - ${tasksString}`);

const config = require(configPath);

(async function() {
  check.assert.object(config, 'config is not an object');
  check.assert.array(config.rooms, 'config.rooms is not an array');

  const mqttClient = new MqttClient({
    url: config.mqttBroker,
    logger,
  });

  const status = {};

  const tasks = {};

  for(const task of tasksString.split(',')) {
    const [room, type] = task.split(':');

    if(room && type) {
      tasks[room.trim()] = tasks[room.trim()] || [];
      tasks[room.trim()].push(type.trim());
    }
  }

  const roomControls = {};

  const handleMqttMessage = async(topic, data) => {
    try {
      logger.debug('handleMqttMessage', topic, data);

      const [
        area,
        areaId,
        element,
        elementId = 'main',
        subArea = 'status',
      ] = topic.split('/');

      if(area === 'room' && subArea === 'status') {
        status[areaId] = status[areaId] || {};
        status[areaId][element] = status[areaId][element] || {};
        status[areaId][element][elementId] = data.value;
      } else if(area === 'room' && element === 'shutter' && ['up', 'down', 'stop', 'toggle', 'max'].includes(subArea)) {
        if(roomControls[areaId]) {
          roomControls[areaId].shutter(subArea, elementId, data.value);
        }
      } else if(area === 'room' && element === 'button' && subArea === 'active') {
        if(roomControls[areaId]) {
          roomControls[areaId].button(subArea, elementId, data.value);
        }
      } else if(area === 'room' && element === 'fan') {
        roomControls[areaId][subArea](elementId, data);
      } else if(area === 'room' && element === 'light') {
        roomControls[areaId][element](elementId, data);
      }
    } catch(err) {
      logger.warn(`Failed to handle mqtt message ${topic}`, err);
    }
  };

  await mqttClient.init(handleMqttMessage);

  await mqttClient.publish(automationInit(raspi), {value: 'done'}, {retain: true});

  for(const roomId of Object.keys(tasks)) {
    const room = _.find(config.rooms, {id: roomId});

    if(tasks[room.id].includes('shutters')) {
      for(const shutter of room.shutters || []) {
        await mqttClient.subscribe(shutterUp(room.id, shutter.id));
        await mqttClient.subscribe(shutterDown(room.id, shutter.id));
        await mqttClient.subscribe(shutterStop(room.id, shutter.id));
        await mqttClient.subscribe(shutterStatus(room.id, shutter.id));
        await mqttClient.subscribe(shutterToggle(room.id, shutter.id));
        await mqttClient.subscribe(shutterMax(room.id, shutter.id));
      }
    }

    if(tasks[room.id].includes('buttons')) {
      for(const button of room.buttons || []) {
        await mqttClient.subscribe(buttonActive(room.id, button.id));
        await mqttClient.subscribe(buttonStatus(room.id, button.id));
      }
    }

    if(tasks[room.id].includes('windows')) {
      for(const window of room.windows || []) {
        await mqttClient.subscribe(windowStatus(room.id, window.id));
      }
    }

    if(tasks[room.id].includes('dht22')) {
      for(const dht22 of room.dht22 || []) {
        await mqttClient.subscribe(temperatureStatus(room.id, dht22.id));
        await mqttClient.subscribe(humidityStatus(room.id, dht22.id));
      }
    }

    if(tasks[room.id].includes('lights')) {
      for(const light of room.lights || []) {
        await mqttClient.subscribe(lightStatus(room.id, light.id));
      }
    }
  }

  // logger.debug(JSON.stringify({tasks, status}, null, 2));

  for(const roomId of Object.keys(tasks)) {
    const room = _.find(config.rooms, {id: roomId});

    roomControls[room.id] = new RoomControl({
      logger,
      room,
      mqttClient,
      status: status[room.id],
      tasks: tasks[roomId],
    });
  }

  setInterval(() => {
    logger.debug('Status', JSON.stringify(status, null, 2));
  }, 30000);
})();
