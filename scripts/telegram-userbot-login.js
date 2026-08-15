#!/usr/bin/env node
'use strict';

require('dotenv').config();
const input = require('input');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

const apiId = Number(process.env.TELEGRAM_USERBOT_API_ID);
const apiHash = process.env.TELEGRAM_USERBOT_API_HASH;

if (!apiId || !apiHash) {
  console.error('Set TELEGRAM_USERBOT_API_ID and TELEGRAM_USERBOT_API_HASH in .env first.');
  console.error('Get both from https://my.telegram.org (API development tools), logged in');
  console.error('as the account you want to run as the forwarding bot.');
  process.exit(1);
}

(async () => {
  console.log('Logging in to Telegram as the userbot account...\n');
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: async () => input.text('Phone number (with country code, e.g. +1...): '),
    password: async () => input.text('2FA password (leave blank if none set): '),
    phoneCode: async () => input.text('Code Telegram just sent you: '),
    onError: (err) => console.error(err),
  });

  console.log('\nLogged in. Save this as TELEGRAM_USERBOT_SESSION in your .env:\n');
  console.log(client.session.save());
  console.log('\nKeep it secret — it is equivalent to your account password. Never commit it.');

  await client.disconnect();
  process.exit(0);
})();
