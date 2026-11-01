# MP4 Grabber + Library

**MP4 Grabber** is a Chrome extension that saves complete HLS, DASH and MP4 videos with sound.
**Library** is its personal companion website. It keeps every download, shows downloads in progress live
on any device, charts their speed, and syncs your preferences back to the extension.

| Part | Folder |
|---|---|
| Chrome extension (v2.1.0) | `extension/` |
| Library server (Node, SQLite, no npm dependencies) | `server/` |
| Library website | `web/` |
| Code shared by both | `shared/` |

How it fits together, and the security model, is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What you get

- **Library.** Every download grouped by day, searchable and filterable by site, type, quality and status. Each one has a detail sheet with its speed graph, size, length, quality, codecs, time taken and the browser that saved it.
- **Active.** Downloads in progress on any connected browser, updating live, with Pause, Resume, Cancel and Stop Recording. It works from your phone too.
- **Insights.** Data downloaded per day, week or month, speed by site, speed by time of day, and the best number of parallel connections for each site.
- **Send to Computer.** Paste a link on your phone. It shows up as a notification and in the MP4 Grabber menu on your computer.
- **Download alerts.** A notification on your phone or computer when a download finishes or fails.
- **Preferences that follow you.** Default quality, what to save, parallel connections (including *Automatic*) and file-name templates such as `{site} – {title} – {quality}`.
- **Privacy.** History is encrypted in your browser with your password, so the server stores ciphertext. Incognito downloads are never saved, sites you list never leave your computer, and you can export as CSV or JSON or delete everything.
- **Plain-language errors.** Failed downloads explain what happened and what to do, in the extension and the Library.

## Hosted on ChatGPT Sites

The hosted address is https://tractor-beam-library.ojburnsey.chatgpt.site.

1. Open the Site and continue with the Site owner's ChatGPT account.
2. Create your Library with the prefilled owner email and a password of at least 10 characters. This password encrypts your history.
3. In the existing extension, choose **Connect Library**, enter the hosted address, compare the codes, then choose **Allow** on the website.

The existing extension remains version 2.1.0 and needs no code or permissions changes. A browser previously linked to a local server must disconnect and connect to the hosted address. Existing local-server history is not automatically transferred. Video files remain on the computer that downloaded them; the Site synchronizes encrypted history, preferences, live progress and links.

ChatGPT Sites must allow public visitors for the unchanged extension to reach its API. The Library still requires its own sign-in for private data and device approval for extension access. Initial account creation requires the owner's verified ChatGPT identity and the `LIBRARY_OWNER_EMAIL` runtime setting, even when the Site is public. The Site starts owner-private until that access change is approved.

`cloud/` adapts the existing API to Cloudflare D1. Database-backed events, live snapshots and queued controls work across Worker instances. Pairing claims are consumed once, sync batches use database transactions, and deleted history cannot be restored by a stale extension outbox. The original local Node server remains available.

Production runtime settings are managed through Sites, never committed:

| Setting | Purpose |
|---|---|
| `LIBRARY_OWNER_EMAIL` | Email of the ChatGPT account allowed to create this personal Library |
| `VAPID_SUBJECT` | Contact for browser push services |

For hosted development, use Node 22.13 or newer, run `npm ci`, then `npm run db:generate` only after schema changes. Run `npm run build` before applying pending migrations locally with the command in `docs/SITES.md`. Start the preview with `npm run site:dev` and run `npm run test:cloud` for D1 integration tests. The browser preview uses the starter's local ChatGPT identity; `.dev.vars` stays untracked.

## 1. Run the Library

You need [Node.js 22.13 or newer](https://nodejs.org). There's nothing to install. From this folder, run:

```bash
npm start
```

Open <http://localhost:4321> and create your account. Sign-up closes automatically once that first account
exists, because this is a personal server. Data is stored in `data/library.sqlite`. Back up that folder.

## 2. Install the extension

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `extension` folder.
   If you used the earlier version, remove it first. The new version needs two extra permissions: **alarms**, to sync every minute, and **notifications**, for links sent from your phone.
3. Click the MP4 Grabber icon, then **Connect Library**. Enter `http://localhost:4321` (or your server's address) and click **Continue**.
4. A Library tab opens. Check that the code matches the one in the extension, then click **Allow**.

That's it. Finished downloads now appear in your Library. Run `npm run package-extension` to get a zip
in `dist/` if you want to install it on another computer.

## 3. Use it from your phone (optional)

Phones can only sign in over **HTTPS**, because the browser's encryption features require a secure connection.
`http://localhost` counts as secure; `http://192.168.x.x` does not. Pick one of these options:

- **Tailscale (simplest, private).** Install [Tailscale](https://tailscale.com) on your computer and phone, then run
  `tailscale serve --bg 4321`. Open the `https://<computer>.<tailnet>.ts.net` address it prints on your phone.
- **A server with a domain.** Run the Docker image behind a reverse proxy that handles HTTPS, such as Caddy:

  ```bash
  docker build -t grabber-library .
  ```

  ```bash
  docker run -d --name library -p 127.0.0.1:4321:4321 -v grabber-data:/data -e TRUST_PROXY=1 grabber-library
  ```

  A Caddy site block containing `reverse_proxy 127.0.0.1:4321` is enough. Keep `TRUST_PROXY=1` only when a proxy
  sits in front.

For notifications on iPhone, open the Library in Safari, choose **Share → Add to Home Screen**, open it from the
Home Screen, then turn on **Settings → Notifications → This device**.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4321` | Port to listen on |
| `HOST` | `127.0.0.1` | Only this computer can connect. Use `0.0.0.0` to accept other devices. |
| `DATA_DIR` | `./data` | Where the database lives |
| `TRUST_PROXY` | off | Trust `X-Forwarded-*` headers from a reverse proxy |
| `ALLOW_SIGNUP` | off | Allow more accounts after the first |
| `VAPID_SUBJECT` | `mailto:owner@localhost` | Contact address push services may use. Set it to your email. |
| `SESSION_DAYS` | `30` | How long you stay signed in |

## Forgot your password?

Your password is what encrypts your history, so nobody can reset it from the website. On the computer
running the server, run:

```bash
npm run reset-password -- you@example.com
```

This sets a new password, but encrypted history can't be read without the old one, so that history is
deleted. Browsers are disconnected and must be connected again. If you had turned encryption off, your
history is kept.

## Development

```bash
npm test
```

```bash
npm run test:e2e
```

- `npm test` runs 41 unit and API tests: crypto, Web Push against the RFC 8291 test vector, sync, pairing, live relay and more.
- `npm run test:e2e` drives the real extension in Chromium against a real server. It needs `ffmpeg` and Playwright. It encodes a test HLS stream, pairs the extension, downloads the stream while pausing and resuming it from the website, checks the saved file with ffprobe, and checks history is encrypted at rest. Add `--demo --screenshots <dir>` to capture every screen with sample data.
- After changing anything in `shared/`, run `npm run sync-shared`. A test fails if `extension/lib/` falls out of date.
