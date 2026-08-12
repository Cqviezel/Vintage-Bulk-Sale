# Crazed TCG

A self-hosted storefront for selling trading card singles, with a password-protected
seller admin and Telegram order notifications.

The design is the original single-file demo; the difference is that inventory, orders
and settings now live in a SQLite database on the server instead of in each visitor's
browser.

```
crazed-tcg/
├── server.js              Express app, sessions, static files
├── src/
│   ├── db.js              SQLite schema + settings
│   ├── auth.js            bcrypt password hashing, route guards
│   ├── telegram.js        Bot API notifications
│   └── routes/
│       ├── public.js      /api/products, /api/orders
│       └── admin.js       /api/admin/* (session-guarded)
├── public/                storefront, login, admin UI
├── scripts/               password, demo seed, logo extraction
├── deploy/                systemd, Caddy, nginx, backup cron
├── data/                  store.db  (gitignored)
└── uploads/               card photos (gitignored)
```

## Run it locally

```bash
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # paste into SESSION_SECRET
npm run set-password -- admin "a-long-passphrase-you-will-remember"
npm run import-demo        # optional: six sample cards
npm start
```

Storefront on http://localhost:3000, admin on http://localhost:3000/admin.

Leave `NODE_ENV` blank locally. Setting it to `production` turns on secure cookies,
which require HTTPS — you will not be able to sign in over plain `http://localhost`.

## Logo assets

Already wired up, extracted from the original demo file:

| File | Size | Used for |
|---|---|---|
| `logo.jpg` | 176 KB, 640×640 | Original. Social share image (`og:image`) |
| `logo-460.jpg` | 57 KB, 460×460 | Hero card, login page, missing-image fallback |
| `favicon.png` | 5 KB, 64×64 | Browser tab |
| `apple-touch-icon.png` | 28 KB, 180×180 | iOS home screen |

To swap in a different logo later, replace `logo.jpg` and regenerate the rest:

```bash
npm install --no-save sharp
node -e "const s=require('sharp');(async()=>{
  await s('public/img/logo.jpg').resize(64,64,{fit:'cover'}).png({palette:true}).toFile('public/img/favicon.png');
  await s('public/img/logo.jpg').resize(180,180,{fit:'cover'}).png({palette:true}).toFile('public/img/apple-touch-icon.png');
  await s('public/img/logo.jpg').resize(460,460,{fit:'inside'}).jpeg({quality:82,mozjpeg:true}).toFile('public/img/logo-460.jpg');
})()"
npm uninstall sharp
```

`scripts/extract-logo.js` pulls a base64 image out of the old single-file demo, if you
ever need it again.

## Telegram notifications

1. Message **@BotFather**, send `/newbot`, copy the token.
2. Send your new bot any message.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `"chat":{"id":...}`.
4. Put both in `.env` as `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_CHAT_ID`, restart.
5. Admin → Settings → **Send test message**.

The token stays on the server. It is never sent to a browser, which is why this cannot
be done from a static page. If Telegram is down, the order is still saved — the failure
is recorded on the order and the **Resend** button retries it.

### Routing to topics

If `TELEGRAM_ADMIN_CHAT_ID` is a group with **Topics** enabled, each notification kind
can be sent to its own topic instead of dumping everything into General:

| Env var | Notification |
|---|---|
| `TELEGRAM_TOPIC_SALES` | New orders (and Admin → Orders → Resend) |
| `TELEGRAM_TOPIC_OUT_OF_STOCK` | A card sells out |

Get a topic's thread ID from its **Copy Link** in Telegram — it's the number after the
chat ID, e.g. `https://t.me/c/<chat>/<THIS NUMBER>`. Leave either blank and that
notification kind falls back to General. **Send test message** always posts to General,
regardless of these settings.

### Current stock report

Out-of-stock alerts carry a **📋 Full stock report** button — tap it, or send `/stock` in
the chat, and the bot replies with everything currently sold out. This is a live snapshot
of the `products` table, not a log: once a sold-out order is marked paid (retiring the
card to **sold**) or the card is restocked, it drops off on the next tap — nothing to
clean up by hand. There's no low-stock alert — only a card actually selling out pings you.

Answering this requires the server to poll Telegram for updates in the background, which
starts automatically whenever the bot is configured. Only run one instance of the app
against a given bot token at a time — e.g. don't leave a local `npm start` running
alongside the production deploy — or they'll race each other for the same button taps.

## Bulk import / export

Admin → Products has **Bulk Import CSV** and **Export CSV**.

Columns: `name, set, number, condition, price, qty, status, image, notes`.
Only `name` is required. Blank `price` becomes 0, blank `qty` becomes 1, and blank
`status` becomes **draft** — so a rough CSV never accidentally puts unpriced cards on
sale. Grab a starting point from **Download template**.

Import is always **preview first**. You see every row, the image the API matched, and
why anything was skipped, before anything is written. Committing runs in a single
transaction: all rows land or none do.

It flags three things worth catching before they reach the storefront:

- **Invalid rows** — bad condition code, negative price, missing name. Listed with the
  spreadsheet line number so you can fix and re-upload.
- **Duplicates** — same name, set, number and condition as something you already have.
  Skipped by default, so re-importing the same file twice will not double your stock.
- **Set mismatches** — if you write `Base` and the API matches `Base Set 2`, the row is
  marked in red rather than quietly using the wrong art.

Export produces the same format, so the round trip works: export, edit prices in a
spreadsheet, re-import.

### Image lookup

Tick *look up card images* and blank `image` cells are filled from
[api.pokemontcg.io](https://api.pokemontcg.io). Matching widens until something hits:
exact set + number, then number, then set, then name alone. The confidence is shown per
row — treat **name only** and **ambiguous** as "check the art before going live".

Set names are the usual trap. The API's `set.name` filter matches loosely, so `"Base"`
also matches `"Base Set 2"` — and returns it *first*. Candidates are therefore scored,
with the `/102` in a number like `4/102` used to pin down which set is meant, since it
gives the set's card count.

Quota is roughly **1,000 lookups a day** anonymously. A free key from
[dev.pokemontcg.io](https://dev.pokemontcg.io) raises it to 20,000 — put it in `.env`
as `POKEMON_TCG_API_KEY`. Results are cached in memory and requests are capped at 4 at
a time, and their API returns occasional 502s so failed lookups are retried twice
before giving up.

The API also reports TCGPlayer market prices, shown next to rows you left unpriced as
a reference. They are never applied automatically — your pricing is yours.

Limits: 500 rows and 2 MB per import.

## Payment flow

There is no payment gateway. Checkout reserves the cards and shows the buyer:

1. **Step 1 — Pay $X.XX** — your PayNow QR, plus the amount and the order ID written
   out as text (a shopper on a phone usually cannot scan a QR shown on that same phone).
2. **Step 2 — Send your payment screenshot** — a link to your Telegram, currently
   `@Cqvie`.

You then confirm the transfer in your banking app and click **Advance** in
Admin → Orders. Nothing marks itself paid.

All of it is editable in Admin → Settings:

| Setting | Effect |
|---|---|
| PayNow QR Code | Image on the confirmation screen. Upload saves immediately |
| PayNow Payee Name | Optional caption under the QR, e.g. your registered name |
| Order Contact Telegram | The handle buyers are told to message |
| PayNow Instructions | The wording of Step 1 |

The QR lives at `uploads/paynow-qr.jpg` and is covered by `deploy/backup.sh`.

> **Verify the QR yourself.** Scan it with your own banking app and confirm the payee
> name is yours before taking real orders. Nothing in this app can check that a QR
> image points at your account — an incorrect one sends customer money elsewhere.

## Deploying to a VPS

Assumes Ubuntu/Debian and a domain already pointed at the server.

```bash
# on the VPS, as root
adduser --system --group --home /opt/crazed-tcg crazedtcg
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs sqlite3

# upload the project to /opt/crazed-tcg (git clone, scp, rsync — your choice)
cd /opt/crazed-tcg
npm ci --omit=dev
cp .env.example .env && nano .env         # SESSION_SECRET, NODE_ENV=production, Telegram
npm run set-password -- admin "a-long-passphrase"
chown -R crazedtcg:crazedtcg /opt/crazed-tcg

cp deploy/crazed-tcg.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now crazed-tcg
journalctl -u crazed-tcg -f               # confirm it started
```

Then put HTTPS in front of it — `deploy/Caddyfile` is the shortest path (automatic
certificates), `deploy/nginx.conf.example` if you prefer nginx + certbot.

Finally, firewall the app port so nobody can bypass your proxy:

```bash
ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
```

`HOST=127.0.0.1` in `.env` is a good extra belt-and-braces once the proxy is working.

### Backups

`deploy/backup.sh` dumps the database and uploads nightly. Copy the archives off the
box — a backup sitting on the same disk is not a backup.

## Day-to-day

| Task | Where |
|---|---|
| Add a card | Admin → Products → Add Product |
| Fill details from card name | Add Product → Search API |
| Take a card off sale | Products → Hide |
| Mark an order paid/packed/mailed | Orders → Advance |
| Cancel and return cards to stock | Orders → View → Cancel & Restock |
| Change mailing fee, PayNow QR or contact | Admin → Settings |
| Change your password | `npm run set-password -- admin "new-passphrase"` |

Only products with status **live** *and* quantity above zero appear on the storefront.

## What the backend guarantees

- **No double-selling.** Reserving stock and writing the order happen in one SQLite
  transaction. Five simultaneous orders for a single card produce one sale and four
  "just sold" errors, verified by test.
- **Prices come from the database.** The browser sends only card IDs; a tampered cart
  that claims a $250 card costs $0.01 is still charged $250.
- **The admin is actually locked.** bcrypt-hashed password, httpOnly session cookie,
  rate-limited login, every `/api/admin/*` route guarded server-side.
- **Uploads are constrained.** Images only, 6 MB cap, random server-side filenames.

## Deliberately not included

- **Automatic payment confirmation.** The PayNow QR is a static image; it cannot tell
  the app that money arrived, and it cannot pre-fill the amount or reference in the
  buyer's banking app. You verify each transfer by hand. Automating this needs either
  a payment provider (Stripe, HitPay) or a dynamic SGQR generated per order.
- **Automatic reservation expiry.** The `reservation` setting is displayed but nothing
  releases a stale unpaid order yet. Cancel it manually to restock.
- **Customer accounts and order-status emails.** Buyers get an order reference on
  screen and are contacted via Telegram.
