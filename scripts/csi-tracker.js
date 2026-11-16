#!/usr/bin/env node
'use strict';

/**
 * Runs the CoolStuffInc stock tracker by hand (see src/csiTracker.js).
 * On the live server it already runs every hour by itself.
 *
 *   node scripts/csi-tracker.js                 scan every set, then write the report
 *   node scripts/csi-tracker.js --report        only rebuild the report
 *   node scripts/csi-tracker.js --watch 60      scan every 60 minutes until stopped
 *   node scripts/csi-tracker.js --sets 360,358  scan only these page ids
 *   node scripts/csi-tracker.js --days 30       report window (default 7 days)
 *   node scripts/csi-tracker.js --notify        also post the changes to the
 *                                               TELEGRAM_TOPIC_CSI_TRACKER topic
 *
 * Data:   <DATA_DIR>/csi-tracker.db     Report: <DATA_DIR>/csi-report.html
 *
 * Posting to Telegram only uses sendMessage, so it does not interfere with the
 * live bot's polling.
 */

require('dotenv').config();
const tracker = require('../src/csiTracker');

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const days = Number(argValue('--days')) || 7;
  if (process.argv.includes('--report')) {
    console.log(`Report: ${tracker.writeReport(days)}`);
    return;
  }

  let sets = tracker.SETS;
  const only = argValue('--sets');
  if (only) {
    const ids = new Set(only.split(',').map((s) => +s.trim()));
    sets = tracker.SETS.filter((s) => ids.has(s.id));
    if (!sets.length) throw new Error(`No known sets match --sets ${only}`);
  }

  const notify = process.argv.includes('--notify');
  if (notify && !tracker.isConfigured()) {
    throw new Error('--notify needs TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID and TELEGRAM_TOPIC_CSI_TRACKER');
  }

  const watchMinutes = Number(argValue('--watch'));
  for (;;) {
    const summary = await tracker.scanAll({ sets });
    console.log(`Report: ${tracker.writeReport(days)}`);
    if (notify) {
      await tracker.notifyTelegram(summary);
      console.log('Posted changes to Telegram.');
    }
    if (!(watchMinutes > 0)) break;
    console.log(`Next scan in ${watchMinutes} minutes (Ctrl+C to stop).\n`);
    await new Promise((r) => setTimeout(r, watchMinutes * 60000));
  }
  tracker.closeDb();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
