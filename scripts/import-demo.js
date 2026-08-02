#!/usr/bin/env node
'use strict';

/** Seeds the six sample cards from the original demo so the store isn't empty. */

require('dotenv').config();
const crypto = require('crypto');
const { db } = require('../src/db');

const SAMPLES = [
  { name: 'Pikachu',    set: 'Base Set', number: '58/102', condition: 'LP', price: 5, image: 'https://images.pokemontcg.io/base1/58_hires.png' },
  { name: 'Charmander', set: 'Base Set', number: '46/102', condition: 'MP', price: 3, image: 'https://images.pokemontcg.io/base1/46_hires.png' },
  { name: 'Bulbasaur',  set: 'Base Set', number: '44/102', condition: 'LP', price: 4, image: 'https://images.pokemontcg.io/base1/44_hires.png' },
  { name: 'Squirtle',   set: 'Base Set', number: '63/102', condition: 'LP', price: 5, image: 'https://images.pokemontcg.io/base1/63_hires.png' },
  { name: 'Gastly',     set: 'Fossil',   number: '50/62',  condition: 'MP', price: 2, image: 'https://images.pokemontcg.io/fossil1/50_hires.png' },
  { name: 'Vulpix',     set: 'Jungle',   number: '68/64',  condition: 'MP', price: 3, image: 'https://images.pokemontcg.io/jungle1/68_hires.png' },
];

const existing = db.prepare('SELECT COUNT(*) n FROM products').get().n;
if (existing > 0) {
  console.log(`Skipped: there are already ${existing} products in the database.`);
  process.exit(0);
}

const insert = db.prepare(
  `INSERT INTO products (id, name, set_name, number, condition, price, qty, status, image, notes)
   VALUES (@id, @name, @set_name, @number, @condition, @price, 1, 'live', @image, '')`
);

const seed = db.transaction(() => {
  for (const s of SAMPLES) {
    insert.run({
      id: 'p' + crypto.randomBytes(8).toString('hex'),
      name: s.name,
      set_name: s.set,
      number: s.number,
      condition: s.condition,
      price: s.price,
      image: s.image,
    });
  }
});

seed();
console.log(`Imported ${SAMPLES.length} sample cards.`);
