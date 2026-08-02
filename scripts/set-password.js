#!/usr/bin/env node
'use strict';

require('dotenv').config();
const auth = require('../src/auth');

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('Usage: npm run set-password -- <username> <password>');
  console.error('Example: npm run set-password -- admin "a-long-passphrase-here"');
  process.exit(1);
}

try {
  auth.setPassword(username, password);
  console.log(`Admin account "${username}" saved. Sign in at /admin/login`);
} catch (err) {
  console.error('Error: ' + err.message);
  process.exit(1);
}
