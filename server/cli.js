// Maintenance commands, run on the server:
//   npm run reset-password -- you@example.com
//
// Resetting a password creates a new encryption key. History that was
// encrypted with the old key can't be read by anyone, so it is deleted, and
// linked browsers are disconnected (they hold the old key). History stored
// with encryption off is kept.

import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";
import { loadConfig } from "./config.js";
import { openDatabase, transaction, nextSeq } from "./db.js";
import { hashSecret } from "./security.js";
import { deriveAccountKeys, createDataKey, wrapDataKey, isEncrypted, KDF_ITERATIONS } from "../shared/vault.js";

async function readHidden(prompt) {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  const write = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = (text) => { if (!write) return; write(text.includes(prompt) ? text : ""); };
  const answer = await rl.question(prompt);
  rl.close();
  stdout.write("\n");
  return answer;
}

async function resetPassword(email) {
  if (!email) {
    console.error("Usage: npm run reset-password -- you@example.com");
    exit(1);
  }
  const db = openDatabase(loadConfig().dataDir);
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase());
  if (!user) {
    console.error(`No account uses ${email}.`);
    exit(1);
  }
  const downloads = db.prepare("SELECT id, sealed FROM downloads WHERE user_id = ?").all(user.id);
  const encrypted = downloads.filter((row) => isEncrypted(row.sealed));
  console.log(`Resetting the password for ${user.email}.`);
  console.log(`${encrypted.length} of ${downloads.length} history entries are encrypted and will be deleted.`);
  console.log("Linked browsers will be disconnected; connect them again afterwards.");
  const password = await readHidden("New password (at least 8 characters): ");
  if (password.length < 8) {
    console.error("The password must be at least 8 characters.");
    exit(1);
  }
  const confirm = await readHidden("Type it again: ");
  if (confirm !== password) {
    console.error("The passwords don't match.");
    exit(1);
  }
  const { authHash, kek } = await deriveAccountKeys(user.email, password, KDF_ITERATIONS);
  const vault = await wrapDataKey(await createDataKey(), kek);
  const hash = await hashSecret(authHash);
  transaction(db, () => {
    db.prepare("UPDATE users SET auth_hash = ?, vault = ?, kdf_iterations = ? WHERE id = ?").run(hash, JSON.stringify(vault), KDF_ITERATIONS, user.id);
    for (const row of encrypted) {
      db.prepare("DELETE FROM downloads WHERE user_id = ? AND id = ?").run(user.id, row.id);
      db.prepare("INSERT OR REPLACE INTO tombstones (user_id, id, seq, deleted_at) VALUES (?, ?, ?, ?)").run(user.id, row.id, nextSeq(db, user.id), Date.now());
    }
    db.prepare("DELETE FROM inbox WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM devices WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  });
  db.close();
  console.log("Done. Sign in on the website with the new password.");
}

const [command, ...rest] = argv.slice(2);
if (command === "reset-password") await resetPassword(rest[0]);
else {
  console.error("Commands: reset-password <email>");
  exit(1);
}
