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

## Put it online (no terminal)

This gives your Library a normal `https://` web address that works from any computer or phone, all the time.
It's hosted on [Render](https://render.com) and set up entirely by clicking.

**Cost:** about **$7.25 a month** (Render's Starter plan at $7, plus 25¢ for the 1 GB disk that stores your account
and history). Render's free plan can't be used because it wipes its storage on every restart.

1. Open **https://render.com/deploy?repo=https://github.com/ojburnsey-tech/tractor-beam**
   (or, in the Render dashboard, choose **New → Blueprint** and pick the `tractor-beam` repository).
2. Sign in to Render with GitHub, and allow it to see the `tractor-beam` repository when asked.
3. Render shows the settings from `render.yaml`. In **VAPID_SUBJECT**, type your email address. Notification services need a contact address.
4. Click **Deploy Blueprint**, then add a payment card when asked.
5. Wait about three minutes until it says **Live**. Your address is shown at the top, e.g. `https://tractor-beam-ab12.onrender.com`.
6. Open that address and create your account. Use a password you'll remember: it also encrypts your history.
7. In the Library, go to **Settings → Browsers → Download MP4 Grabber for Chrome**, then:
   1. Double-click the downloaded file to unzip it.
   2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose the unzipped **MP4 Grabber** folder. Remove any older copy first.
   3. Click the MP4 Grabber icon, then **Connect Library**, then **Continue**. Your address is already filled in.
   4. Click **Allow** in the tab that opens.
8. **On your phone**, open the same address and sign in. On iPhone, tap **Share → Add to Home Screen** and open the
   Library from that icon. Then turn on **Settings → Notifications → This device**.

**Updates** install themselves: every change pushed to the `main` branch redeploys the site within a few minutes,
and your data stays on the disk. If the extension changes too, download it again from Settings, then click the reload
arrow on MP4 Grabber in `chrome://extensions`.

You can add your own domain in Render under **Settings → Custom Domains**. If you do, connect the extension to
the new address afterwards.

## Or run it on your own computer

You need [Node.js 22.13 or newer](https://nodejs.org). There's nothing to install. From this folder, run:

```bash
npm start
```

Open <http://localhost:4321> and create your account. Sign-up closes automatically once that first account
exists, because this is a personal server. Data is stored in `data/library.sqlite`. Back up that folder.
Install the extension from **Settings → Browsers** as described above.

To use a computer-hosted Library from your phone you need HTTPS. Phones refuse to sign in over plain `http://`,
except on `localhost`. The simplest way is [Tailscale](https://tailscale.com): run `tailscale serve --bg 4321` and open the
`https://…ts.net` address it prints. If you'd rather use your own server, there's a `Dockerfile`; put it behind a
reverse proxy such as Caddy and set `TRUST_PROXY=1`.

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

Your password is what encrypts your history, so nobody can reset it from the website. On Render, open your
service, go to the **Shell** tab and run the command below. On your own computer, run it in the project folder:

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

- `npm test` runs 44 unit and API tests: crypto, Web Push against the RFC 8291 test vector, sync, pairing, live relay and more.
- `npm run test:e2e` drives the real extension in Chromium against a real server. It needs `ffmpeg` and Playwright. It encodes a test HLS stream, pairs the extension, downloads the stream while pausing and resuming it from the website, checks the saved file with ffprobe, and checks history is encrypted at rest. Add `--demo --screenshots <dir>` to capture every screen with sample data.
- After changing anything in `shared/`, run `npm run sync-shared`. A test fails if `extension/lib/` falls out of date.
