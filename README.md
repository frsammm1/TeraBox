# TeraBox Telegram Bot + API

Self-hosted Node.js 22+ service that resolves TeraBox share links and exposes
them through a small HTTP API and a Telegram control bot, with an optional
worker that downloads and re-uploads large files straight into Telegram via
raw MTProto.

This repo is a standalone, Docker-ready extraction of the `api-server`
package from the original Replit monorepo, prepared for **container-based
deployment on Heroku**.

## Stack

- Node.js 22+, TypeScript 5 (NodeNext)
- Raw `node:http` (no Express)
- In-memory LRU + TTL cache for resolved shares
- Telegram long-polling bot (no webhook needed)
- Optional raw MTProto uploader (`teleproto`) for files bigger than the
  normal 50 MB Bot API limit
- `node:sqlite` (built into Node 22) for transfer-job persistence — no
  external database required

## Project layout

```
src/
  index.ts             entry point, wires everything together
  config.ts             env-var config loading & validation
  server.ts             HTTP API server (/, /api, /health, /admin)
  lib/
    cache.ts             ExpiringCache (LRU + TTL + in-flight dedup)
    share-service.ts      CachedShareService (wraps TeraBoxClient)
    terabox.ts            TeraBoxClient (resolves share links)
    telegram.ts           TelegramBot (long-polling, file browser, commands)
    transfer.ts            TransferManager + HttpFileDownloader + ZipArchiveSplitter
    transfer-store.ts      SQLite persistence for transfer jobs/events
    mtproto-uploader.ts    MtprotoBotUploader (raw Telegram upload)
    utils.ts               shared helpers (URL validation, cookies, formatting)
Dockerfile
heroku.yml
.env.example
```

## 1. Push this repo to GitHub

```bash
git init
git add .
git commit -m "Initial commit: terabox telegram bot"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 2. Configure environment variables

Copy `.env.example` to `.env` for local testing and fill in real values.
See the table below for what's required.

| Variable | Required? | Purpose |
|---|---|---|
| `TERABOX_COOKIES_JSON` | Yes | JSON object of cookies from a logged-in TeraBox web session |
| `TELEGRAM_BOT_TOKEN` | Yes (to enable the bot) | Token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_ALLOWED_USER_IDS` | Yes, unless `TELEGRAM_ALLOW_PUBLIC=true` | Comma-separated numeric Telegram user IDs allowed to use the bot |
| `TELEGRAM_ALLOW_PUBLIC` | No (default `false`) | Set `true` to let anyone use the bot instead of an allow-list |
| `TELEGRAM_UPLOAD_ENABLED` | No (default `false`) | Enables the raw MTProto large-file worker |
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | Only if upload worker enabled | From [my.telegram.org](https://my.telegram.org) |
| `ADMIN_API_KEY` | No | Enables the protected `/admin` dashboard (min 16 chars) |
| `PORT` | No | Heroku sets this automatically — don't override it |

The full list of tunable variables (cache TTL, transfer limits, retry
behaviour, etc.) is documented in `.env.example`.

**Get `TERABOX_COOKIES_JSON`:** log in to TeraBox in a browser, open dev tools
→ Application → Cookies, and copy the relevant cookies (e.g. `ndus`, `BDUSS`)
into a JSON object, e.g. `{"ndus":"...","BDUSS":"..."}`.

## 3. Deploy to Heroku (Docker/container stack)

Requires the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli).

```bash
heroku login
heroku create your-app-name

# Switch the app to the container stack so Heroku builds from the Dockerfile
heroku stack:set container -a your-app-name

# Set config vars (repeat/add any others from the table above)
heroku config:set \
  TERABOX_COOKIES_JSON='{"ndus":"...","BDUSS":"..."}' \
  TELEGRAM_BOT_TOKEN='123456:your-bot-token' \
  TELEGRAM_ALLOWED_USER_IDS='111111111,222222222' \
  -a your-app-name

# Deploy
git push heroku main
```

Heroku reads `heroku.yml`, builds the image from `Dockerfile`, and runs
`node dist/index.js` with `PORT` injected automatically — `config.ts` already
reads `process.env.PORT`, so nothing else is needed.

Watch the logs to confirm it started:

```bash
heroku logs --tail -a your-app-name
```

You should see `[server] API listening on http://0.0.0.0:<port>` and, if a
bot token is set, the bot starting up.

### Alternative: connect GitHub in the Heroku dashboard

1. Heroku dashboard → your app → **Settings** → **Stack** → set to `container`.
2. **Deploy** tab → connect the GitHub repo you pushed in step 1.
3. Enable automatic deploys (optional) and click **Deploy Branch**.
4. Add the same config vars under **Settings → Config Vars**.

## 4. One important limitation on Heroku

Heroku's filesystem is **ephemeral** — it resets on every dyno restart/deploy.
That's fine for the resolver/cache/bot itself, but if you enable
`TELEGRAM_UPLOAD_ENABLED=true` (large-file transfer worker), don't rely on
`TRANSFER_TEMP_DIR`/`TRANSFER_DATABASE_PATH` surviving a restart — in-flight
jobs won't resume after a dyno cycles. For heavy transfer workloads, a host
with a persistent disk is a better fit than Heroku.

## Local development (without Docker)

```bash
npm install
cp .env.example .env   # fill in values
npm run dev             # tsx watch src/index.ts
```

Build and run the compiled version:

```bash
npm run build
npm start
```

## API endpoints

See `TERABOX_INTERNAL_API.md` for the internal TeraBox API details the
resolver talks to. The server itself exposes:

- `GET /health` — liveness check
- `GET /api/...` — share-resolution endpoints
- `GET /admin` — protected dashboard (requires `ADMIN_API_KEY`)

## License

MIT (inherited from the original project).
