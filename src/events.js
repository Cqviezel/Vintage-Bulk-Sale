'use strict';

const { EventEmitter } = require('events');

// Lets orders.js announce restocks and referral rewards without requiring telegram.js,
// which already requires orders.js.
module.exports = new EventEmitter();
