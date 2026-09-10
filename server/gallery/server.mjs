import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, createReadStream, existsSync, realpathSync } from "node:fs";
import { open, rename, unlink, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const deriveKey = promisify(scrypt);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (value) => createHash("sha256").update(value).digest("hex"); // Stores session-token hashes so database access does not reveal usable cookies.
const token = () => randomBytes(32).toString("hex");
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".woff2": "font/woff2" };

export async function passwordRecord(username, password) {
  if (!username.trim() || username.length > 100 || password.length < 12 || password.length > 1024) throw new Error("Use a username and a password between 12 and 1024 characters.");
  const salt = token();
  const hash = await deriveKey(password, salt, 64);
  return { username: username.trim(), salt, hash: hash.toString("hex") }; // Saves a salted scrypt hash; the original password is never written to disk.
}

function textField(value, max, required = false) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) fail(400, `Please provide ${required ? "a nonempty " : "a "}text value of at most ${max} characters.`);
  return value.trim();
}

async function readJson(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) fail(415, "This request requires JSON.");
  const parts = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) fail(413, "The submitted text is too large.");
    parts.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch { fail(400, "Please provide a valid JSON object."); }
}

function detectMedia(bytes) {
  // Checks content signatures instead of trusting uploaded names or MIME headers. Active SVG/HTML files are excluded.
  if (bytes.length < 12) fail(415, "This file is empty or is not a supported photo or video.");
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return ["image", ".png"];
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ["image", ".jpg"];
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return ["image", ".gif"];
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return ["image", ".webp"];
  if (bytes.toString("ascii", 4, 8) === "ftyp" && ["isom", "iso2", "mp41", "mp42", "avc1", "M4V "].includes(bytes.toString("ascii", 8, 12))) return ["video", ".mp4"];
  if (bytes.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex")) && bytes.subarray(0, 4096).includes(Buffer.from("webm"))) return ["video", ".webm"];
  fail(415, "Use JPG, PNG, GIF, WebP, MP4 or WebM files. This file's contents were not recognized.");
}

export function createGalleryServer(options = {}) {
  const webRoot = realpathSync(options.webRoot || path.join(root, "web"));
  const dataDir = path.resolve(options.dataDir || process.env.GALLERY_DATA_DIR || path.join(root, "gallery-data"));
  if (dataDir === webRoot || dataDir.startsWith(webRoot + path.sep)) throw new Error("GALLERY_DATA_DIR must be outside the public web directory.");
  mkdirSync(path.join(dataDir, "uploads"), { recursive: true, mode: 0o700 });
  const origin = new URL(options.origin || process.env.GALLERY_ORIGIN || "http://localhost:8787").origin;
  const secure = origin.startsWith("https:");
  if (!secure && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) throw new Error("Public galleries require an HTTPS GALLERY_ORIGIN.");
  const maxUploadMB = Number(options.maxUploadMB || process.env.GALLERY_MAX_UPLOAD_MB || 250);
  if (!Number.isFinite(maxUploadMB) || maxUploadMB < 1 || maxUploadMB > 2048) throw new Error("GALLERY_MAX_UPLOAD_MB must be between 1 and 2048.");
  const adminPath = path.join(dataDir, "admin.json");
  if (!existsSync(adminPath)) throw new Error("Run node server/gallery/setup.mjs to create the gallery owner first.");
  const db = new DatabaseSync(path.join(dataDir, "gallery.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sets (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, cover_id TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE, filename TEXT NOT NULL, kind TEXT NOT NULL, caption TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS items_set ON items(set_id);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, authenticated INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (address TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS attempt_time ON attempts(created);`);
  const query = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const cookieName = secure ? "__Secure-ldq_gallery" : "ldq_gallery";

  function sessionFor(request) {
    const value = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
    return one("SELECT * FROM sessions WHERE id=? AND expires>?", digest(value), Date.now()) || null;
  }

  function newSession(response, authenticated) {
    const value = token();
    const csrf = token();
    const lifetime = authenticated ? 43200 : 3600;
    run("DELETE FROM sessions WHERE expires<=?", Date.now());
    if (one("SELECT count(*) AS total FROM sessions").total > 10000) fail(503, "The gallery is busy. Please try again later.");
    run("INSERT INTO sessions VALUES (?, ?, ?, ?)", digest(value), csrf, authenticated ? 1 : 0, Date.now() + lifetime * 1000);
    response.setHeader("Set-Cookie", `${cookieName}=${value}; Path=/gallery/; HttpOnly; SameSite=Strict; Max-Age=${lifetime}${secure ? "; Secure" : ""}`);
    return { csrf, authenticated: Boolean(authenticated) }; // Gives the browser a CSRF token while the session cookie remains inaccessible to scripts.
  }

  function json(response, status, data) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(data));
  }

  async function sendFile(request, response, filename, contentType) {
    const info = await stat(filename).catch(() => fail(404, "File not found."));
    if (!info.isFile()) fail(404, "File not found.");
    let start = 0;
    let end = info.size - 1;
    let status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (!match[1] && !match[2])) { response.setHeader("Content-Range", `bytes */${info.size}`); fail(416, "Invalid media range."); }
      start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { response.setHeader("Content-Range", `bytes */${info.size}`); fail(416, "Invalid media range."); }
      status = 206;
      response.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
    }
    response.writeHead(status, { "Content-Type": contentType, "Content-Length": Math.max(0, end - start + 1), "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
    if (request.method === "HEAD" || info.size === 0) { response.end(); return; }
    const stream = createReadStream(filename, { start, end });
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response); // Supports seeking in videos without loading a whole file into server memory.
  }

  async function removeFiles(filenames) {
    await Promise.all(filenames.map((name) => unlink(path.join(dataDir, "uploads", name)).catch((error) => {
      if (error.code !== "ENOENT") console.error("Could not remove unlisted gallery file:", name, error.code);
    }))); // Deleted database entries become inaccessible immediately, even if disk cleanup needs attention.
  }

  let activeUploads = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    try {
      const url = new URL(request.url, origin);
      const pathname = decodeURIComponent(url.pathname);
      const method = request.method;
      if (pathname === "/" || pathname === "/gallery") { response.writeHead(308, { Location: "/gallery/" }); response.end(); return; }
      if (pathname.startsWith("/gallery/")) {
        response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
      }
      if (!pathname.startsWith("/gallery/api/")) {
        if (!["GET", "HEAD"].includes(method)) fail(405, "Method not allowed.");
        if (pathname.startsWith("/gallery/media/")) {
          const id = pathname.slice("/gallery/media/".length);
          const item = one("SELECT * FROM items WHERE id=?", id);
          if (!item) fail(404, "Media not found.");
          await sendFile(request, response, path.join(dataDir, "uploads", item.filename), MIME[path.extname(item.filename)]);
          return;
        }
        if (pathname.includes("\\") || pathname.split("/").some((part) => part.startsWith("."))) fail(404, "Page not found.");
        let filename = path.resolve(webRoot, `.${pathname}`);
        if (pathname.endsWith("/")) filename = path.join(filename, "index.html");
        const real = existsSync(filename) ? realpathSync(filename) : filename;
        if (!real.startsWith(webRoot + path.sep)) fail(404, "Page not found.");
        await sendFile(request, response, real, MIME[path.extname(real)] || "application/octet-stream");
        return;
      }

      const route = pathname.slice("/gallery/api/".length);
      const session = sessionFor(request);
      if (method === "GET" && route === "session") {
        const current = session ? { authenticated: Boolean(session.authenticated), csrf: session.csrf } : newSession(response, false);
        json(response, 200, { ...current, max_upload_mb: maxUploadMB }); return;
      }
      if (method === "GET" && route === "sets") {
        const items = query("SELECT id, set_id, kind, caption FROM items ORDER BY created, rowid");
        const sets = query("SELECT * FROM sets ORDER BY created DESC, rowid DESC").map((set) => ({ ...set, items: items.filter((item) => item.set_id === set.id).map((item) => ({ ...item, url: `/gallery/media/${item.id}` })) }));
        json(response, 200, { sets }); return;
      }
      if (!["POST", "PATCH", "DELETE"].includes(method)) fail(405, "Method not allowed.");
      if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site") fail(403, "This action must come from the gallery website.");
      if (route !== "login" && !session?.authenticated) fail(401, "Please log in to manage the gallery.");
      if (!session || request.headers["x-csrf-token"] !== session.csrf) fail(403, "Your session changed. Refresh the page and try again.");

      if (route === "login" && method === "POST") {
        const address = request.socket.remoteAddress || "unknown"; // Does not trust spoofable forwarded-address headers.
        run("DELETE FROM attempts WHERE created<?", Date.now() - 900000);
        if (one("SELECT count(*) AS total FROM attempts WHERE address=?", address).total >= 10 || one("SELECT count(*) AS total FROM attempts").total >= 100) fail(429, "Too many login attempts. Try again in 15 minutes.");
        run("INSERT INTO attempts VALUES (?, ?)", address, Date.now());
        const data = await readJson(request);
        const username = textField(data.username, 100, true);
        const password = typeof data.password === "string" && data.password.length <= 1024 ? data.password : "";
        const owner = JSON.parse(readFileSync(adminPath, "utf8"));
        const hash = await deriveKey(password, owner.salt, 64);
        const valid = timingSafeEqual(hash, Buffer.from(owner.hash, "hex"));
        if (!valid || username !== owner.username) fail(401, "Username or password is incorrect.");
        run("DELETE FROM sessions WHERE id=?", session.id);
        json(response, 200, newSession(response, true)); return;
      }
      if (route === "logout" && method === "POST") {
        run("DELETE FROM sessions WHERE id=?", session.id);
        response.setHeader("Set-Cookie", `${cookieName}=; Path=/gallery/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
        json(response, 200, { ok: true }); return;
      }
      if (route === "sets" && method === "POST") {
        const data = await readJson(request);
        const id = randomUUID();
        run("INSERT INTO sets VALUES (?, ?, ?, NULL, ?)", id, textField(data.title, 120, true), textField(data.description ?? "", 2000), Date.now());
        json(response, 201, { id }); return;
      }
      const setMatch = /^sets\/([a-f0-9-]{36})(\/items)?$/.exec(route);
      if (setMatch) {
        const set = one("SELECT * FROM sets WHERE id=?", setMatch[1]);
        if (!set) fail(404, "This collection no longer exists.");
        if (setMatch[2] && method === "POST") {
          if (activeUploads >= 3) fail(429, "Please wait for another upload to finish.");
          const maxBytes = maxUploadMB * 1024 * 1024;
          if (Number(request.headers["content-length"]) > maxBytes) fail(413, `Files must be at most ${maxUploadMB} MB.`);
          const id = randomUUID();
          const temporary = path.join(dataDir, "uploads", `${id}.part`);
          let finalName;
          activeUploads += 1;
          try {
            const file = await open(temporary, "wx", 0o600);
            let size = 0;
            let signature = Buffer.alloc(0);
            try {
              for await (const chunk of request) {
                size += chunk.length;
                if (size > maxBytes) fail(413, `Files must be at most ${maxUploadMB} MB.`);
                if (signature.length < 4096) signature = Buffer.concat([signature, chunk.subarray(0, 4096 - signature.length)]);
                await file.writeFile(chunk);
              }
            } finally { await file.close(); }
            const [kind, extension] = detectMedia(signature);
            if (!one("SELECT id FROM sessions WHERE id=? AND authenticated=1 AND expires>?", session.id, Date.now())) fail(401, "Your session ended before the upload finished. Please log in again.");
            if (!one("SELECT id FROM sets WHERE id=?", set.id)) fail(409, "This collection was deleted during the upload.");
            finalName = `${id}${extension}`;
            await rename(temporary, path.join(dataDir, "uploads", finalName));
            run("INSERT INTO items VALUES (?, ?, ?, ?, '', ?)", id, set.id, finalName, kind, Date.now());
            run("UPDATE sets SET cover_id=? WHERE id=? AND cover_id IS NULL", id, set.id);
            json(response, 201, { id });
          } catch (error) {
            await unlink(temporary).catch(() => {});
            if (finalName && !one("SELECT id FROM items WHERE id=?", id)) await removeFiles([finalName]);
            throw error;
          } finally { activeUploads -= 1; }
          return;
        }
        if (!setMatch[2] && method === "PATCH") {
          const data = await readJson(request);
          let cover = set.cover_id;
          if (Object.hasOwn(data, "cover_id")) {
            if (typeof data.cover_id !== "string" || !one("SELECT id FROM items WHERE id=? AND set_id=?", data.cover_id, set.id)) fail(400, "Choose a cover from this collection.");
            cover = data.cover_id;
          }
          run("UPDATE sets SET title=?, description=?, cover_id=? WHERE id=?", textField(data.title ?? set.title, 120, true), textField(data.description ?? set.description, 2000), cover, set.id);
          json(response, 200, { id: set.id }); return;
        }
        if (!setMatch[2] && method === "DELETE") {
          const files = query("SELECT filename FROM items WHERE set_id=?", set.id);
          run("DELETE FROM sets WHERE id=?", set.id); // The foreign key removes all media records in the same database statement.
          await removeFiles(files.map((file) => file.filename));
          json(response, 200, { ok: true }); return;
        }
      }
      const itemMatch = /^items\/([a-f0-9-]{36})$/.exec(route);
      if (itemMatch) {
        const item = one("SELECT * FROM items WHERE id=?", itemMatch[1]);
        if (!item) fail(404, "This file no longer exists.");
        if (method === "PATCH") {
          const data = await readJson(request);
          run("UPDATE items SET caption=? WHERE id=?", textField(data.caption, 500), item.id);
          json(response, 200, { id: item.id }); return;
        }
        if (method === "DELETE") {
          db.exec("BEGIN");
          try {
            run("DELETE FROM items WHERE id=?", item.id);
            run("UPDATE sets SET cover_id=(SELECT id FROM items WHERE set_id=? ORDER BY created, rowid LIMIT 1) WHERE id=? AND cover_id=?", item.set_id, item.set_id, item.id);
            db.exec("COMMIT");
          } catch (error) { db.exec("ROLLBACK"); throw error; }
          await removeFiles([item.filename]);
          json(response, 200, { ok: true }); return;
        }
      }
      fail(404, "Gallery endpoint not found.");
    } catch (error) {
      if (!error.status) console.error("Gallery request failed:", error.code || error.name);
      if (!response.headersSent && !response.destroyed) json(response, error.status || 500, { error: error.status ? error.message : "The gallery could not complete that request. Please try again." });
      else response.destroy();
    }
  });
  server.requestTimeout = 15 * 60 * 1000; // Allows large video uploads on slower connections while bounding abandoned requests.
  server.headersTimeout = 20000;
  server.on("close", () => db.close());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const server = createGalleryServer();
  server.listen(port, process.env.HOST || "127.0.0.1", () => console.log(`Gallery listening on port ${port}. Public origin: ${process.env.GALLERY_ORIGIN || "http://localhost:8787"}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
}
