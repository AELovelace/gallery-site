import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { passwordRecord } from "./server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dataDir = path.resolve(process.env.GALLERY_DATA_DIR || path.join(root, "gallery-data"));
const webRoot = path.join(root, "web");
if (dataDir === webRoot || dataDir.startsWith(webRoot + path.sep)) throw new Error("Keep gallery data outside web/.");
let muted = false;
const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); } }); // Suppresses password echo without putting a secret in command history.
const prompt = createInterface({ input: process.stdin, output, terminal: true });
try {
  const adminPath = path.join(dataDir, "admin.json");
  if (existsSync(adminPath) && (await prompt.question("Replace the existing owner password? Type YES: ")) !== "YES") process.exitCode = 1;
  else {
    const username = await prompt.question("Owner username: ");
    process.stdout.write("Password (at least 12 characters; hidden): ");
    muted = true;
    const password = await prompt.question("");
    muted = false;
    process.stdout.write("\nConfirm password (hidden): ");
    muted = true;
    const confirmation = await prompt.question("");
    muted = false;
    process.stdout.write("\n");
    if (password !== confirmation) throw new Error("Passwords do not match.");
    const owner = await passwordRecord(username, password);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(adminPath, JSON.stringify(owner, null, 2) + "\n", { mode: 0o600 });
    if (existsSync(path.join(dataDir, "gallery.sqlite"))) {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path.join(dataDir, "gallery.sqlite"));
      db.exec("DELETE FROM sessions"); // Revokes existing sessions when the owner changes the password.
      db.close();
    }
    console.log("Gallery owner saved. Start with: node server/gallery/server.mjs");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { muted = false; prompt.close(); }
