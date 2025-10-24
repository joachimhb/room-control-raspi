'use strict';

const log4js = require('log4js');
const delay  = require('delay');

const logger = log4js.getLogger();

logger.level = 'trace';

const {
  controls,
} = require('@joachimhb/smart-home-shared');

const {Shutter} = controls;

(async function() {
  const room = {
    id: 'manual',
    label: 'manual',
  };
  const shutter = {
    id: 'manual',
    label: 'manual',
    powerGpio: 6,
    directionGpio: 12,
    fullCloseMs: 20000
  };

  const shutterCtrl = new Shutter({
    logger,
    location: `${room.label}/${shutter.label}`,
    ...shutter,
    status: 0,
    onStatusUpdate: async value => {
      logger.trace(value);
    },
    onStop: async() => {
      logger.trace('stop');
    },
  });

  shutterCtrl.up({force: true});
  await delay(2000);
  shutterCtrl.stop();
})();

