# CloudFlare-Clipboard

CloudFlare-Clipboard is a private online clipboard built on Cloudflare Workers and D1.

It uses AccessDock as the access-control service. The clipboard Worker calls AccessDock before rendering the page, while write operations use either the current AccessDock session or a short-lived page action token.

## Features

- Single private clipboard
- Save and clear text
- D1 persistence
- AccessDock integration inside the business Worker
- Compatible with AccessDock admin, fixed password, fixed password every refresh, and temporary code modes

## Project Structure

```text
src/index.js               Worker app, page rendering, and clipboard APIs
src/accessdock-client.js   AccessDock check helper
migrations/0001_init.sql   D1 schema
wrangler.toml              Local template config
scripts/render-wrangler.mjs  Generates deploy config from build variables
```

## Cloudflare Git Deploy

Use a private GitHub repository named:

```text
CloudFlare-Clipboard
```

Use this deploy command in Cloudflare Workers Git deploy:

```text
npm run deploy
```

This project keeps `wrangler.toml` as a template. During deployment, `scripts/render-wrangler.mjs` creates an ignored `wrangler.generated.toml` file from Cloudflare build variables. Do not commit the real D1 database id.

## Cloudflare Setup

Create a D1 database:

```powershell
wrangler d1 create clipboard
```

Add these build environment variables in Cloudflare:

```text
D1_DATABASE_ID=your-real-d1-database-id
D1_DATABASE_NAME=clipboard
WORKER_NAME=cloudflare-clipboard
ACCESSDOCK_BASE_URL=https://auth.leiyun.blog
```

Only `D1_DATABASE_ID` is required. The other values have defaults.

Set these runtime variables and secrets in Cloudflare Workers:

```text
ACCESSDOCK_BASE_URL=https://auth.leiyun.blog
ACTION_TOKEN_SECRET=a-long-random-secret
```

Optional:

```text
ACTION_TOKEN_SECONDS=1800
```

Apply the migration:

```powershell
npm run db:migrate
```

When running migrations from Cloudflare Git deploy, make sure `D1_DATABASE_ID` exists as a build environment variable.

For local development:

```powershell
npm run db:migrate:local
npm run dev
```

## AccessDock Rule

Create a rule in AccessDock:

```text
host: clipboard.leiyun.blog
pathPattern: /*
mode: fixed password / fixed password every refresh / temporary code / admin only
```

Recommended private mode:

```text
固定密码-每次验证
```

In this mode, refreshing the page requires AccessDock verification again. The already opened page can still save and clear because this Worker issues a short-lived action token after AccessDock grants page access.

## Auth Behavior

AccessDock returns one of these roles:

```text
admin   Admin session
access  Fixed password or time-limited temporary code session
grant   One-time grant, such as fixed password every refresh or once temporary code
```

Write APIs work like this:

- `admin` and `access`: the API checks AccessDock again and follows the AccessDock cookie lifetime.
- `grant`: the API checks the page action token generated when the page was opened.

The action token is embedded in the page JavaScript. It is not saved to localStorage and is not a long-lived cookie.

## Deploy

```powershell
npm run deploy
```

Bind the Worker to:

```text
clipboard.leiyun.blog
```

If you connect this project to GitHub, keep the repository private and avoid editing the deployed Worker source directly in the Cloudflare dashboard.
