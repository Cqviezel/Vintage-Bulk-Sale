#!/usr/bin/env node
'use strict';

/**
 * Pulls the base64 logo out of the original single-file demo and saves it as a
 * real image, so the storefront can serve it normally.
 *
 *   node scripts/extract-logo.js "C:\path\to\crazed_tcg_backend_notification_flow.html"
 *
 * Then point LOGO_SRC in public/js/store.js at the file it writes.
 */

const fs = require('fs');
const path = require('path');

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/extract-logo.js <path-to-old-demo.html>');
  process.exit(1);
}

const html = fs.readFileSync(source, 'latin1');
const match = html.match(/data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]{500,})/);

if (!match) {
  console.error('No embedded base64 image found in that file.');
  process.exit(1);
}

const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
const outDir = path.join(__dirname, '..', 'public', 'img');
const outFile = path.join(outDir, `logo.${ext}`);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, Buffer.from(match[2], 'base64'));

const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`Wrote ${outFile} (${kb} KB)`);
console.log(`Now set  const LOGO = '/img/logo.${ext}';  in public/js/store.js`);
