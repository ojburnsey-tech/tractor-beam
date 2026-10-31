# MP4 Grabber Library — Architecture

A personal companion website for the MP4 Grabber Chrome extension. It keeps a
permanent, searchable history of every download, shows downloads in progress
live (from any device), and syncs preferences back to the extension.

The system is three parts that share one data model:

| Part | Where | Responsibility |
|---|---|---|
| **Extension** | `extension/` | Detects and downloads media (unchanged engine), records history and speed, syncs to the server, relays live progress, receives links. |
| **Server** | `server/` | Accounts, sessions, linked browsers, encrypted history store, live relay, inbox, Web Push. Node ≥ 22.13, SQLite (`node:sqlite`), no runtime npm dependencies. |
| **Website** | `web/` | Sign-in, Library, Active, Insights, Send, Settings. Framework-free ES modules served by the server. Installable as a PWA for phone notifications. |
| **Shared** | `shared/` | Code both sides must agree on: crypto (`vault.js`), error explanations, filename templates, privacy rules, formatting, smart concurrency. Copied into `extension/lib/` by `npm run sync-shared`; a test fails if the copies drift. |

## Artifact edition

The Library can also run as a claude.ai artifact (`artifact/`, built by
`scripts/build-artifact.js` into one self-contained page). It reuses the
website's views; four modules are swapped: `store.js`, `bridge.js`,
`router.js` (hash routes, because artifacts only keep `#name`) and the
Settings view.

* **Storage:** the artifact's `db`, under the viewer's private
  `data/users/<id>/` subtree: `prefs`, `library/downloads/*`,
  `library/devices/*`, `library/inbox/*`. Sign-in is the person's Claude
  account. There is no password-derived encryption in this edition; the
  private subtree is enforced by the platform.
* **Extension link:** an artifact can't be called from the internet, so
  the extension talks to the open Library page through `bridge.js`. The
  content script runs in all frames, because the artifact is framed inside
  claude.ai, sandboxed with an opaque origin. Pairing starts from the page
  ("Connect This Browser"). The extension opens its own confirmation tab
  showing a code that the page also shows, and links only after the person
  approves. Pending pairings survive service-worker restarts
  (`chrome.storage.session`). Once linked, the extension accepts only the
  artifact's origin.
* **Sync:** the extension sends outbox entries in batches; the page writes
  each to `db` and acknowledges by batch id before the extension removes
  them. Settings, links sent to the computer, deletions and disconnects
  flow back over the same bridge. Entries wait in the outbox while the
  Library is closed.
* **Live view and remote control:** the Library page on the downloading
  computer relays its jobs over the artifact's `room` (messages are capped
  at 4 KB, so up to three jobs with 48 s of speed history, in KB/s). Other
  open Libraries (a phone) render them and send `command` messages back,
  which the relaying page hands to the extension.
* **Not available:** Web Push (artifacts can't register service workers)
  and syncing while no Library tab is open.

## Hard rules

1. **No credentials ever leave the extension.** Authorization headers, cookies,
   custom auth headers and raw stream URLs (which often carry signed tokens)
   are never synced. History stores the page title, the page's site and a
   cleaned page URL (`shared/privacy.js#cleanPageUrl` strips token-like query
   parameters and fragments).
2. **Incognito downloads are never stored or synced.**
3. **Sites on the "never sync" list stay on the computer** — they appear in the
   popup's recent list but never reach the server.
4. **With encryption on (the default), the server cannot read what you
   downloaded.** Titles, sites, URLs, filenames and error text are encrypted in
   the browser. Only numbers (sizes, speeds, durations, timestamps) and
   categorical fields (stream type, state) are stored in the clear, so the
   server stays a dumb store and every view is computed client-side.

## Accounts and keys

The password never reaches the server.

```
masterKey = PBKDF2-SHA256(password, "mp4grabber/v1/" + lower(email), 600 000 iterations)
authHash  = HKDF(masterKey, info "mp4grabber/v1/auth")    → sent to server, stored as scrypt(authHash)
kek       = HKDF(masterKey, info "mp4grabber/v1/vault")   → AES-256-GCM key, never leaves the browser
dataKey   = random AES-256-GCM key created at sign-up
vault     = AES-GCM(kek, dataKey)                         → stored on server (wrapped)
```

* Signing in derives `kek`, unwraps `dataKey`, and keeps it in the website's
  IndexedDB until sign-out (so a 30-day session doesn't ask for the password
  again). A valid session with no key shows an **Unlock** screen.
* Changing the password re-wraps `dataKey`; no history is re-encrypted.
* `npm run reset-password` (server shell) can recover a forgotten password,
  but encrypted history and linked browsers are erased, because the old key is
  unrecoverable by design. With encryption off, history survives a reset.

### Sealed records

Private fields travel as a *sealed* string:

```
{"v":1,"e":0,"d":{…}}                       encryption off
{"v":1,"e":1,"iv":"…","ct":"…"}             AES-256-GCM, AAD = record id
```

Binding the record id as additional authenticated data stops a server from
swapping one record's private fields onto another.

## Linking a browser (pairing)

Started from the extension (popup → *Connect account*), so a malicious web page
can never point the extension at its own server.

1. The extension's `link.html` creates an ECDH P-256 key pair, a request id and
   a secret, and registers `{id, sha256(secret), publicKey, name}` with the
   server (unauthenticated, rate-limited, 10-minute expiry).
2. It opens `<server>/link#r=<id>`. Both pages show the same 6-character code
   derived from the public key.
3. The signed-in website encrypts `dataKey` to the extension's public key
   (ephemeral ECDH → HKDF → AES-GCM) and approves. The server mints a device
   token, stored only as a hash.
4. The extension claims with its secret, receives the token and the
   encrypted key once, and decrypts the key locally. The server never sees
   `dataKey`.

The token and key live in the extension's IndexedDB, which content scripts
cannot reach. Disconnecting a browser in Settings deletes its token; the
extension notices on its next sync (HTTP 401) and forgets the key.

## Extension ↔ website bridge

When the website is open in the same Chrome that runs the extension, it talks
to the extension directly for instant live progress and controls.

`bridge.js` (content script) relays `window.postMessage` traffic to a
background port. The background accepts the port only if the page's origin is
the linked server's origin and it is the top frame; otherwise it disconnects
silently and the content script never answers, so other sites cannot detect
the extension.

## Live progress

* The download tab reports progress to the background every 300 ms.
* The background forwards it instantly over the bridge and posts a batch to the
  server every 2 s (`POST /api/live/push`). The response carries any pending
  commands (pause, resume, cancel, stop recording), so remote control from a
  phone has about 2 s of latency.
* The server keeps live snapshots in memory only and streams them to the
  website over Server-Sent Events (`/api/events`). A snapshot not refreshed for
  15 s is dropped.
* Chrome-native "Original file" downloads are sampled every second and appear
  in the same live view; their controls map to `chrome.downloads`.

## History and sync

* Each finished download becomes an *entry* in the extension's IndexedDB and an
  item in its outbox. Entries are sealed at push time, so the current
  encryption setting always applies.
* `POST /api/sync/push` upserts entries; `GET /api/sync/pull?since=` returns
  preferences, privacy settings, deletions made on the website and links sent
  to this browser. Sync runs on change, every minute via `chrome.alarms`, and
  whenever the popup opens. Failed pushes retry with backoff; nothing is lost
  while offline.
* The server assigns a monotonic `updated_at` per user, used as the cursor.
  Deletions leave tombstones so other clients can catch up.

### Speed recording

`SpeedRecorder` buckets received bytes into 1 s samples (paused seconds are
recorded as gaps), keeps at most 240 points by halving resolution when full,
and computes average speed over *active* time and peak speed over a 3-sample
moving window, so one burst doesn't count as the peak.

## Smart concurrency

For a site, completed stream downloads of at least 20 MB are grouped by the
parallel-connection setting used (1, 3, 6). The median speed per level decides;
a lower level within 8 % of the best wins (gentler on the network). If only
lower levels have been tried, the next level up is tried once. With no
history, 3. Shared between the extension (chooses) and the website (Insights
shows the choice per site).

## Done alerts

Web Push (VAPID + RFC 8291 `aes128gcm`, implemented on `node:crypto`). When an
entry first arrives in a final state within 15 minutes of finishing, each
subscribed device gets a notification. With encryption on, the server only
knows the numbers, so the alert reads e.g. "Download finished · 1.4 GB in
3:12"; with encryption off, the extension includes the title.

On iPhone, notifications require the site to be added to the Home Screen
(iOS 16.4+) and served over HTTPS.

## Send to computer

The website seals a link and posts it to the inbox, optionally targeted at
one browser. The extension pulls it, shows a system notification and lists it
in the popup. Opening it starts the download page (for media and playlist
links) or opens the page so the extension can detect the video. Chrome only
lets the save dialog open after a click, so downloads cannot start unattended.

## Server security

* Sessions: random 256-bit tokens, stored hashed; `HttpOnly; SameSite=Lax`,
  `Secure` over HTTPS; 30-day rolling expiry.
* CSRF: cookie-authenticated writes require `X-Requested-With: grabber` (forces
  a CORS preflight that the server never approves) and, when an `Origin`
  header is present, that its host matches the request's host (hosts, not
  schemes, so HTTPS-terminating proxies such as Tailscale Serve work).
* Sign-up is open only while the server has no account (`ALLOW_SIGNUP=1`
  overrides). It's a personal server.
* Rate limits on sign-in, sign-up and link requests; constant-time comparisons;
  1 MB request bodies; strict CSP (`script-src 'self'`), `frame-ancestors
  'none'`, `Referrer-Policy: no-referrer`.

## Data model (SQLite)

| Table | Purpose |
|---|---|
| `users` | email, scrypt(authHash), wrapped vault, settings JSON |
| `sessions` | website sessions (token hash, expiry, user agent) |
| `devices` | linked browsers (token hash, name, last seen) |
| `link_requests` | pending pairings (10-minute lifetime) |
| `downloads` | history entries: clear numeric fields + `sealed` + `samples` JSON |
| `tombstones` | deletions for incremental sync |
| `inbox` | links sent to a computer |
| `push_subscriptions` | Web Push endpoints per device |
| `meta` | VAPID key pair, schema version |
