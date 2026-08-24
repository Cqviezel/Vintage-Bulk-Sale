#!/usr/bin/env node
'use strict';

require('dotenv').config();
const qrcode = require('qrcode-terminal');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

const apiId = Number(process.env.TELEGRAM_USERBOT_API_ID);
const apiHash = process.env.TELEGRAM_USERBOT_API_HASH;

if (!apiId || !apiHash) {
  console.error('Set TELEGRAM_USERBOT_API_ID and TELEGRAM_USERBOT_API_HASH in .env first.');
  process.exit(1);
}

(async () => {
  console.log('Logging in to Telegram via QR code...\n');
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  await client.signInUserWithQrCode(
    { apiId, apiHash },
    {
      onError: async (err) => {
        console.error('Login error:', err.message || err);
        return false;
      },
      qrCode: async (code) => {
        const link = `tg://login?token=${code.token.toString('base64url')}`;
        console.log('\nOpen Telegram on your phone -> Settings -> Devices -> Link Desktop Device, then scan:\n');
        qrcode.generate(link, { small: true });
        console.log('(Link expires in ~' + Math.max(0, Math.round((code.expires * 1000 - Date.now()) / 1000)) + 's — a fresh QR will print automatically if it does.)\n');
      },
      password: async () => {
        const input = require('input');
        return input.text('2FA password (leave blank if none set): ');
      },
    }
  );

  console.log('\nLogged in. Save this as TELEGRAM_USERBOT_SESSION in your .env:\n');
  console.log(client.session.save());
  console.log('\nKeep it secret — it is equivalent to your account password. Never commit it.');

  await client.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('ERROR:', err.message || err);
  process.exit(1);
});
