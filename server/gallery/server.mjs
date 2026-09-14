import http from "node:http";
import { initAccounts, createIdentity } from "./identity.mjs";
import { createPreviews } from "./previews.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createHash, createHmac, scrypt, timingSafeEqual } from "node:crypto";
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
  const maxUploadMB = Number(options.maxUploadMB || process.env.GALLERY_MAX_UPLOAD_MB || 1024); // Defaults to 1 GiB per file; the session response supplies this limit to the upload UI.
  if (!Number.isFinite(maxUploadMB) || maxUploadMB < 1 || maxUploadMB > 2048) throw new Error("GALLERY_MAX_UPLOAD_MB must be between 1 and 2048.");

  const db = new DatabaseSync(path.join(dataDir, "gallery.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sets (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, cover_id TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE, filename TEXT NOT NULL, kind TEXT NOT NULL, caption TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS items_set ON items(set_id);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, authenticated INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (address TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS attempt_time ON attempts(created);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS set_views (target TEXT REFERENCES sets(id) ON DELETE CASCADE, visitor TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY(target, visitor, day));
    CREATE TABLE IF NOT EXISTS item_views (target TEXT REFERENCES items(id) ON DELETE CASCADE, visitor TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY(target, visitor, day));
    CREATE TABLE IF NOT EXISTS set_likes (target TEXT REFERENCES sets(id) ON DELETE CASCADE, visitor TEXT NOT NULL, PRIMARY KEY(target, visitor));
    CREATE TABLE IF NOT EXISTS item_likes (target TEXT REFERENCES items(id) ON DELETE CASCADE, visitor TEXT NOT NULL, PRIMARY KEY(target, visitor));`);
  initAccounts(db);
  const identity = createIdentity(db, { origin, issuer: options.issuer || process.env.GALLERY_OIDC_ISSUER || "https://auth.sadgirlsclub.wtf", clientId: options.clientId || process.env.GALLERY_OIDC_CLIENT_ID || "lidoll-gallery" });
  const previews = createPreviews(dataDir, options.ffmpeg);
  const query = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const visitorCookieName = secure ? "__Secure-ldq_visitor" : "ldq_visitor";
  run("INSERT OR IGNORE INTO settings VALUES ('visitor_secret', ?)", token());
  const visitorSecret = one("SELECT value FROM settings WHERE key='visitor_secret'").value; // Persists browser identity signatures through restarts and owner-password changes.
  const signVisitor = (value) => createHmac("sha256", visitorSecret).update(value).digest("hex");

  function appendCookie(response, cookie) {
    const existing = response.getHeader("Set-Cookie") || [];
    response.setHeader("Set-Cookie", [...(Array.isArray(existing) ? existing : [existing]), cookie]); // Allows anonymous identity and login-session cookies to be issued together.
  }

  function visitorFor(request) {
    const value = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${visitorCookieName}=`))?.slice(visitorCookieName.length + 1);
    if (!value || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(value)) return null;
    const [identity, signature] = value.split(".");
    if (!timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signVisitor(identity), "hex"))) return null;
    return digest(identity); // Stores only a random browser-identifier hash with reactions, never an IP or fingerprint.
  }

  function newVisitor(response) {
    const identity = token();
    appendCookie(response, `${visitorCookieName}=${identity}.${signVisitor(identity)}; Path=/gallery/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? "; Secure" : ""}`);
  }

  function engagement(kind, id, visitor) {
    // Table names come exclusively from the fixed route enum; target and visitor values stay parameterized.
    return {
      views: one(`SELECT count(*) AS total FROM ${kind}_views WHERE target=?`, id).total,
      likes: one(`SELECT count(*) AS total FROM ${kind}_likes WHERE target=?`, id).total,
      liked: Boolean(visitor && one(`SELECT 1 FROM ${kind}_likes WHERE target=? AND visitor=?`, id, visitor)),
    };
  }

  const sessionFor = request => identity.session(request);
  function requireUser(request) { // Rejects anonymous, expired and disabled accounts at the server boundary.
    const current = sessionFor(request);
    if (!current?.authenticated) fail(401, "Sign in with LiDollID to continue.");
    return current;
  }
  function requireEditor(request, setId = null) { // Contributors can change only their own collections; the owner can manage every collection.
    const current = requireUser(request);
    if (!current.can_post) fail(403, "Posting permission is required.");
    if (setId && !current.admin && one("SELECT owner_id FROM sets WHERE id=?", setId)?.owner_id !== current.user_id) fail(403, "You can manage only your own collections.");
    return current;
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
    response.writeHead(status, { "Content-Type": contentType, "Content-Length": Math.max(0, end - start + 1), "Accept-Ranges": "bytes", "Cache-Control": response.getHeader("Cache-Control") || "no-cache" });
    if (request.method === "HEAD" || info.size === 0) { response.end(); return; }
    const stream = createReadStream(filename, { start, end });
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response); // Supports seeking in videos without loading a whole file into server memory.
  }

  async function removeFiles(filenames) {
    await Promise.all(filenames.map(name => previews.remove(path.parse(name).name)));
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
      if (pathname.startsWith("/gallery/auth/")) {
        await identity.route(request, response, pathname.slice("/gallery/auth/".length)); return;
      }
      if (!pathname.startsWith("/gallery/api/")) {
        if (!["GET", "HEAD"].includes(method)) fail(405, "Method not allowed.");
        const mediaRoute = /^\/gallery\/(media|download|preview)\/([a-f0-9-]{36})$/.exec(pathname);
        if (mediaRoute) {
          const [, mode, id] = mediaRoute;
          const item = one("SELECT * FROM items WHERE id=?", id);
          if (!item) fail(404, "Media not found.");
          if (mode === "preview") {
            const preview = await previews.get(item);
            if (!one("SELECT id FROM items WHERE id=?", id)) fail(404, "Media not found.");
            if (!preview) { response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" }); response.end(method === "HEAD" ? undefined : '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="100%" height="100%" fill="#370f2d"/><text x="50%" y="50%" text-anchor="middle" fill="#ffb3d4" font-size="20">Preview unavailable</text></svg>'); return; }
            await sendFile(request, response, preview, "image/webp"); return;
          }
          if (mode === "download" || item.kind !== "video") requireUser(request); // Public videos support playback and seeking; downloads and full-size photos still require a live account.
          response.setHeader("Cache-Control", "private, no-store");
          if (mode === "download") response.setHeader("Content-Disposition", 'attachment; filename="gallery-' + item.id + path.extname(item.filename) + '"');
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
      const visitor = visitorFor(request);
      const likeIdentity = session?.authenticated ? "account:" + session.user_id : null;
      if (method === "GET" && route === "session") {
        if (!visitor) newVisitor(response);
        const current = session ? identity.summary(session) : identity.createSession(response);
        json(response, 200, { ...current, max_upload_mb: maxUploadMB }); return;
      }
      if (method === "GET" && route === "sets") {
        const items = query("SELECT id, set_id, kind, caption FROM items ORDER BY created, rowid");
        const sets = query("SELECT * FROM sets ORDER BY created DESC, rowid DESC").map((set) => ({ ...set, can_edit: Boolean(session?.can_post && (session.admin || set.owner_id === session.user_id)), ...engagement("set", set.id, likeIdentity), items: items.filter((item) => item.set_id === set.id).map((item) => ({ ...item, ...engagement("item", item.id, likeIdentity), url: `/gallery/media/${item.id}`, preview_url: `/gallery/preview/${item.id}`, download_url: `/gallery/download/${item.id}` })) }));
        json(response, 200, { sets }); return;
      }
      if (method === "GET" && route === "users") {
        if (!requireUser(request).admin) fail(403, "Owner access is required.");
        const search = (url.searchParams.get("q") || "").slice(0,100);
        const page = Math.max(0, Math.min(100000, Number(url.searchParams.get("page")) || 0)) | 0;
        const filter = "%" + search.replace(/[\\%_]/g, value => "\\" + value) + "%";
        json(response, 200, { users: query("SELECT id,username,issuer,subject,role,disabled,created,last_login,(SELECT count(*) FROM sets WHERE owner_id=gallery_users.id) AS collections FROM gallery_users WHERE username LIKE ? ESCAPE '\\' ORDER BY created,id LIMIT 50 OFFSET ?", filter, page * 50), total: one("SELECT count(*) AS total FROM gallery_users WHERE username LIKE ? ESCAPE '\\'", filter).total, page }); return;
      }
      if (!["POST", "PATCH", "DELETE"].includes(method)) fail(405, "Method not allowed.");
      if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site") fail(403, "This action must come from the gallery website.");
      const reaction = /^(sets|items)\/([a-f0-9-]{36})\/(view|like)$/.exec(route);
      if (reaction && method === "POST") {
        if (!session || !visitor) fail(401, "Refresh the gallery to enable views and likes.");
        if (request.headers["x-csrf-token"] !== session.csrf) fail(403, "Your session changed. Refresh the page and try again.");
        const [, collection, id, action] = reaction;
        const kind = collection === "sets" ? "set" : "item";
        if (!one(`SELECT id FROM ${collection} WHERE id=?`, id)) fail(404, "This collection or file no longer exists.");
        if (action === "view") {
          run(`INSERT OR IGNORE INTO ${kind}_views VALUES (?, ?, ?)`, id, visitor, Math.floor(Date.now() / 86400000)); // Deduplicates opens per browser per UTC day, including concurrent requests.
        } else {
          requireUser(request);
          const data = await readJson(request);
          requireUser(request);
          if (typeof data.liked !== "boolean") fail(400, "Provide a true or false liked value.");
          if (!one(`SELECT id FROM ${collection} WHERE id=?`, id)) fail(404, "This collection or file no longer exists.");
          if (data.liked) run(`INSERT OR IGNORE INTO ${kind}_likes VALUES (?, ?)`, id, likeIdentity);
          else run(`DELETE FROM ${kind}_likes WHERE target=? AND visitor=?`, id, likeIdentity);
        }
        json(response, 200, engagement(kind, id, likeIdentity)); return;
      }
      requireUser(request);
      if (request.headers["x-csrf-token"] !== session.csrf) fail(403, "Your session changed. Refresh the page and try again.");
      if (route === "logout" && method === "POST") {
        identity.logout(request, response);
        json(response, 200, { ok: true }); return;
      }
      const userMatch = /^users\/([a-f0-9-]{36})$/.exec(route);
      if (userMatch && method === "PATCH") {
        if (!requireUser(request).admin) fail(403, "Owner access is required.");
        const data = await readJson(request);
        const actor = requireUser(request);
        if (!actor.admin) fail(403, "Owner access is required.");
        const target = one("SELECT * FROM gallery_users WHERE id=?", userMatch[1]);
        if (!target) fail(404, "User not found.");
        if (target.role === "owner") fail(403, "The owner account cannot be disabled or demoted here.");
        if (!['viewer','contributor'].includes(data.role) || typeof data.disabled !== 'boolean') fail(400, "Choose viewer or contributor and a valid account status.");
        db.exec("BEGIN IMMEDIATE");
        try {
          run("UPDATE gallery_users SET role=?,disabled=? WHERE id=?", data.role, data.disabled ? 1 : 0, target.id);
          if (data.disabled) run("DELETE FROM sessions WHERE user_id=?", target.id);
          run("INSERT INTO user_audit(actor,target,action,created) VALUES (?,?,?,?)", actor.user_id, target.id, JSON.stringify({ role: data.role, disabled: data.disabled }), Date.now());
          db.exec("COMMIT");
        } catch(error) { db.exec("ROLLBACK"); throw error; }
        json(response, 200, { ok: true }); return;
      }
      requireEditor(request);
      if (route === "sets" && method === "POST") {
        const data = await readJson(request);
        const actor = requireEditor(request);
        const id = randomUUID();
        run("INSERT INTO sets(id,title,description,cover_id,created,owner_id) VALUES (?, ?, ?, NULL, ?, ?)", id, textField(data.title, 120, true), textField(data.description ?? "", 2000), Date.now(), actor.user_id);
        json(response, 201, { id }); return;
      }
      const setMatch = /^sets\/([a-f0-9-]{36})(\/items)?$/.exec(route);
      if (setMatch) {
        const set = one("SELECT * FROM sets WHERE id=?", setMatch[1]);
        if (!set) fail(404, "This collection no longer exists.");
        requireEditor(request, set.id);
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
            requireEditor(request, set.id);
            if (!one("SELECT id FROM sets WHERE id=?", set.id)) fail(409, "This collection was deleted during the upload.");
            finalName = `${id}${extension}`;
            await rename(temporary, path.join(dataDir, "uploads", finalName));
            requireEditor(request, set.id); // Rechecks revocation after the asynchronous rename, before committing uploaded media.
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
          requireEditor(request, set.id);
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
        requireEditor(request, item.set_id);
        if (method === "PATCH") {
          const data = await readJson(request);
          requireEditor(request, item.set_id);
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
      if (!response.headersSent && !response.destroyed && request.url.startsWith('/gallery/auth/')) {
        response.writeHead(error.status || 503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LiDollID sign-in</title><link rel="stylesheet" href="/gallery/theme.css"><link rel="stylesheet" href="/gallery/style.css"><main class="gallery-shell"><h1>Sign-in could not be completed</h1><p>Your sign-in may have expired, access may be disabled, or LiDollID may be unavailable.</p><a class="action primary" href="/gallery/">Return to the gallery</a></main></html>');
      }
      else if (!response.headersSent && !response.destroyed) json(response, error.status || 500, { error: error.status ? error.message : "The gallery could not complete that request. Please try again." });
      else response.destroy();
    }
  });
  server.requestTimeout = 60 * 60 * 1000; // Allows a 1 GiB video to upload over a slower connection while retaining a one-hour request deadline.
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
