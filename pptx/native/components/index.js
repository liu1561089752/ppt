'use strict';

const text = require('./text');
const cards = require('./cards');
const diagrams = require('./diagrams');

module.exports = Object.assign({}, text, cards, diagrams);
