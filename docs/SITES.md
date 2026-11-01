# ChatGPT Sites hosting

The hosting identity is in `.openai/hosting.json`. Reuse it for updates. `DB` is provisioned by Sites; production migrations are applied from `drizzle/` during deployment. Never modify a migration after deployment.

## Local preview

Use Node 22.13 or newer. Run `npm ci`, then `npm run build`. Add a local `.dev.vars` containing `LIBRARY_OWNER_EMAIL="seedy@sites.test"` and `VAPID_SUBJECT="mailto:seedy@sites.test"`. This matches the supplied Sites starter's local sign-in account.

Apply the pending initial migration once:

```bash
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_sticky_risque.sql
```

Start with `npm run site:dev`, open the printed local address and continue with ChatGPT. Preview data lives in `.wrangler/state` and is separate from production. Keep `.dev.vars` and `.wrangler` untracked.

## Validation

```bash
npm test
npm run test:cloud
npm run build
```

Cloud tests use the actual Worker runtime and D1 emulator. They cover owner-only setup, encrypted sync, simultaneous pairing approvals and claims, persistence across restarts, remote control delivery, targeted inbox access, deletion tombstones, browser revocation, password changes and account deletion.

## Publication

Prepare and push the source through the Sites workflow helper, package its verified build, and deploy the saved version with the existing project ID. Production secrets are configured in Sites. Preserve the existing audience on subsequent deployments.

The original extension sends its device bearer token with `credentials: omit`. It cannot authenticate to the ChatGPT Sites private gate. Public Site access is therefore required for this unchanged client; the Library API independently protects private records through HttpOnly sessions, CSRF checks and hashed device tokens.

Push delivery requires the browser's notification permission and a supported push service. Live events reconnect regularly and recover current state from D1. Files themselves are downloaded by the extension and are never uploaded to Sites.
