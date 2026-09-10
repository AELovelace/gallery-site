import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createGalleryServer, passwordRecord } from "./server.mjs";

const origin = "http://localhost:8787";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "lidoll-gallery-test-"));
  await writeFile(path.join(dataDir, "admin.json"), JSON.stringify(await passwordRecord("doll", "test-password-for-gallery")));
  if (options.prepare) await options.prepare(dataDir); // Allows an actual pre-update database to be opened by the new server in migration coverage.
  let server;
  let base;
  async function start() {
    server = createGalleryServer({ dataDir, origin, maxUploadMB: 1, ...options });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
  await start();
  t.after(async () => {
    await stop();
    const resolved = path.resolve(dataDir);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("lidoll-gallery-test-")) throw new Error("Unsafe test cleanup path.");
    await rm(resolved, { recursive: true, force: true }); // Removes only the uniquely allocated test data directory after closing SQLite.
  });
  function client() {
    const cookies = new Map();
    let csrf = "";
    return {
      async request(route, { method = "GET", body, headers = {}, raw = false } = {}) {
        const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
        const response = await fetch(`${base}${route}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== "GET" ? { Origin: origin, "X-CSRF-Token": csrf } : {}), ...(body && !raw ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
        for (const header of response.headers.getSetCookie()) {
          const [name, value] = header.split(";")[0].split("=");
          if (value) cookies.set(name, value); else cookies.delete(name);
        } // Models separate visitor/session cookies, including session rotation and logout.
        const bytes = Buffer.from(await response.arrayBuffer());
        let data;
        try { data = JSON.parse(bytes.toString()); } catch { data = null; }
        if (data?.csrf) csrf = data.csrf;
        return { status: response.status, headers: response.headers, bytes, data };
      },
      async login() {
        assert.equal((await this.request("/gallery/api/session")).status, 200);
        assert.equal((await this.request("/gallery/api/login", { method: "POST", body: { username: "doll", password: "test-password-for-gallery" } })).status, 200);
      },
    };
  }
  return { client, dataDir, restart: async () => { await stop(); await start(); } };
}

test("owner login, public collections, uploads, edits, restart persistence and deletion", async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const visitor = app.client();
  await owner.login();
  const created = await owner.request("/gallery/api/sets", { method: "POST", body: { title: "A first collection", description: "Two memories" } });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const upload = await owner.request(`/gallery/api/sets/${id}/items`, { method: "POST", body: png, raw: true, headers: { "Content-Type": "image/png" } });
  assert.equal(upload.status, 201);
  const itemId = upload.data.id;
  const videoBytes = Buffer.concat([Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex"), Buffer.alloc(100)]);
  const video = await owner.request(`/gallery/api/sets/${id}/items`, { method: "POST", body: videoBytes, raw: true });
  assert.equal(video.status, 201);
  assert.equal((await owner.request(`/gallery/api/items/${itemId}`, { method: "PATCH", body: { caption: '<script>alert("caption")</script>' } })).status, 200);
  assert.equal((await owner.request(`/gallery/api/sets/${id}`, { method: "PATCH", body: { title: "Renamed set", cover_id: video.data.id } })).status, 200);
  await app.restart();
  const publicSets = (await visitor.request("/gallery/api/sets")).data.sets;
  assert.equal(publicSets[0].title, "Renamed set");
  assert.equal(publicSets[0].items.length, 2);
  assert.equal(publicSets[0].items[0].caption, '<script>alert("caption")</script>');
  assert.equal(publicSets[0].cover_id, video.data.id);
  const image = await visitor.request(`/gallery/media/${itemId}`);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual(image.bytes, png);
  const range = await visitor.request(`/gallery/media/${video.data.id}`, { headers: { Range: "bytes=4-11" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 4-11/${videoBytes.length}`);
  assert.deepEqual(range.bytes, videoBytes.subarray(4, 12));
  assert.equal((await visitor.request(`/gallery/media/${video.data.id}`, { headers: { Range: "bytes=9999-" } })).status, 416);
  assert.equal((await owner.request(`/gallery/api/items/${video.data.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await visitor.request("/gallery/api/sets")).data.sets[0].cover_id, itemId);
  assert.equal((await owner.request(`/gallery/api/sets/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await visitor.request(`/gallery/media/${itemId}`)).status, 404);
  assert.deepEqual((await visitor.request("/gallery/api/sets")).data.sets, []);
  assert.deepEqual(await readdir(path.join(app.dataDir, "uploads")), []);
});

test("anonymous mutations, cross-origin requests, bad CSRF, logout and expired sessions are rejected", async (t) => {
  const app = await fixture(t);
  const client = app.client();
  const create = { method: "POST", body: { title: "Private edit", description: "" } };
  assert.equal((await client.request("/gallery/api/sets", create)).status, 401);
  await client.request("/gallery/api/session");
  assert.equal((await client.request("/gallery/api/login", { method: "POST", body: { username: "doll", password: "wrong" } })).status, 401);
  await client.login();
  assert.equal((await client.request("/gallery/api/sets", { ...create, headers: { Origin: "https://other.example" } })).status, 403);
  assert.equal((await client.request("/gallery/api/sets", { ...create, headers: { "X-CSRF-Token": "wrong" } })).status, 403);
  assert.equal((await client.request("/gallery/api/logout", { method: "POST" })).status, 200);
  assert.equal((await client.request("/gallery/api/sets", create)).status, 401);
  await client.login();
  const db = new DatabaseSync(path.join(app.dataDir, "gallery.sqlite"));
  db.exec("UPDATE sessions SET expires=0");
  db.close();
  assert.equal((await client.request("/gallery/api/sets", create)).status, 401);
});

test("invalid files, oversized files, invalid fields and cross-set covers are rejected", async (t) => {
  const app = await fixture(t);
  const client = app.client();
  await client.login();
  assert.equal((await client.request("/gallery/api/sets", { method: "POST", body: { title: "   " } })).status, 400);
  assert.equal((await client.request("/gallery/api/sets", { method: "POST", body: { title: ["bad"] } })).status, 400);
  const id = (await client.request("/gallery/api/sets", { method: "POST", body: { title: "File validation" } })).data.id;
  const uploadRoute = `/gallery/api/sets/${id}/items`;
  assert.equal((await client.request(uploadRoute, { method: "POST", raw: true, body: Buffer.from('<svg onload="alert(1)"></svg>'), headers: { "Content-Type": "image/png" } })).status, 415);
  assert.equal((await client.request(uploadRoute, { method: "POST", raw: true, body: Buffer.alloc(1024 * 1024 + 1) })).status, 413);
  assert.deepEqual(await readdir(path.join(app.dataDir, "uploads")), []);
  const otherId = (await client.request("/gallery/api/sets", { method: "POST", body: { title: "Other" } })).data.id;
  const itemId = (await client.request(`/gallery/api/sets/${otherId}/items`, { method: "POST", raw: true, body: png })).data.id;
  assert.equal((await client.request(`/gallery/api/sets/${id}`, { method: "PATCH", body: { cover_id: itemId } })).status, 400);
});

test("login rate limits survive sessions and public routes do not expose storage", async (t) => {
  const app = await fixture(t);
  const client = app.client();
  await client.request("/gallery/api/session");
  for (let index = 0; index < 10; index++) {
    assert.equal((await client.request("/gallery/api/login", { method: "POST", body: { username: "doll", password: "incorrect" } })).status, 401);
  }
  assert.equal((await client.request("/gallery/api/login", { method: "POST", body: { username: "doll", password: "test-password-for-gallery" } })).status, 429);
  for (const route of ["/gallery-data/admin.json", "/server/gallery/server.mjs", "/.git/config", "/gallery/%2e%2e%5c%2e%2e%5c.git/config"]) assert.equal((await client.request(route)).status, 404);
  const page = await client.request("/gallery/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /object-src 'none'/);
  const session = await app.client().request("/gallery/api/session");
  assert.match(session.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
});

test("HTTPS origins enable secure session cookies", async (t) => {
  const app = await fixture(t, { origin: "https://lidoll.dev" });
  const session = await app.client().request("/gallery/api/session");
  assert.ok(session.headers.getSetCookie().some((value) => /^__Secure-ldq_gallery=.*; Secure$/.test(value)));
  assert.ok(session.headers.getSetCookie().some((value) => /^__Secure-ldq_visitor=.*HttpOnly; SameSite=Strict; Max-Age=31536000; Secure$/.test(value)));
});

test("public likes are idempotent, removable and persistent; daily views deduplicate separately for sets and media", async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const first = app.client();
  const second = app.client();
  await owner.login();
  const set = (await owner.request("/gallery/api/sets", { method: "POST", body: { title: "Reactions" } })).data.id;
  const item = (await owner.request(`/gallery/api/sets/${set}/items`, { method: "POST", body: png, raw: true })).data.id;
  await first.request("/gallery/api/session");
  await second.request("/gallery/api/session");
  for (const route of [`sets/${set}`, `items/${item}`]) {
    const base = `/gallery/api/${route}`;
    assert.deepEqual((await first.request(`${base}/view`, { method: "POST" })).data, { views: 1, likes: 0, liked: false });
    const repeats = await Promise.all(Array.from({ length: 5 }, () => first.request(`${base}/view`, { method: "POST" })));
    assert.ok(repeats.every((result) => result.status === 200 && result.data.views === 1));
    assert.equal((await second.request(`${base}/view`, { method: "POST" })).data.views, 2);
    const likes = await Promise.all(Array.from({ length: 5 }, () => first.request(`${base}/like`, { method: "POST", body: { liked: true } })));
    assert.ok(likes.every((result) => result.status === 200 && result.data.likes === 1));
    assert.equal((await second.request(`${base}/like`, { method: "POST", body: { liked: true } })).data.likes, 2);
    assert.deepEqual((await first.request(`${base}/like`, { method: "POST", body: { liked: false } })).data, { views: 2, likes: 1, liked: false });
    assert.equal((await first.request(`${base}/like`, { method: "POST", body: { liked: false } })).data.likes, 1);
  }
  await app.restart();
  const sets = (await second.request("/gallery/api/sets")).data.sets;
  assert.equal(sets[0].liked, true);
  assert.equal(sets[0].items[0].liked, true);
  assert.equal(sets[0].views, 2);
  assert.equal(sets[0].items[0].views, 2);
  assert.equal((await first.request("/gallery/api/sets")).data.sets[0].liked, false);
  assert.equal((await app.client().request("/gallery/api/sets")).data.sets[0].likes, 1);
  assert.equal((await second.request(`/gallery/api/sets/${set}/view`, { method: "POST" })).data.views, 2);
  await second.login();
  await second.request("/gallery/api/logout", { method: "POST" });
  await second.request("/gallery/api/session");
  assert.equal((await second.request("/gallery/api/sets")).data.sets[0].liked, true);
  const db = new DatabaseSync(path.join(app.dataDir, "gallery.sqlite"));
  db.exec("UPDATE set_views SET day=day-1; UPDATE item_views SET day=day-1");
  db.close();
  assert.equal((await second.request(`/gallery/api/sets/${set}/view`, { method: "POST" })).data.views, 3);
  assert.equal((await second.request(`/gallery/api/items/${item}/view`, { method: "POST" })).data.views, 3);
  await owner.request(`/gallery/api/sets/${set}`, { method: "DELETE" });
  const check = new DatabaseSync(path.join(app.dataDir, "gallery.sqlite"));
  for (const table of ["set_views", "item_views", "set_likes", "item_likes"]) assert.equal(check.prepare(`SELECT count(*) AS total FROM ${table}`).get().total, 0);
  check.close();
});

test("public reactions enforce session, signed identity, origin and CSRF without granting editing privileges", async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const visitor = app.client();
  await owner.login();
  const id = (await owner.request("/gallery/api/sets", { method: "POST", body: { title: "Protected" } })).data.id;
  const route = `/gallery/api/sets/${id}`;
  assert.equal((await visitor.request(`${route}/view`, { method: "POST" })).status, 401);
  const visitorSession = await visitor.request("/gallery/api/session");
  assert.equal((await visitor.request(`${route}/like`, { method: "POST", body: { liked: true }, headers: { Origin: "https://other.example" } })).status, 403);
  assert.equal((await visitor.request(`${route}/view`, { method: "POST", headers: { "X-CSRF-Token": "forged" } })).status, 403);
  assert.equal((await visitor.request(`${route}/like`, { method: "POST", body: { liked: "yes" } })).status, 400);
  assert.equal((await visitor.request(`${route}/view`, { method: "GET" })).status, 405);
  assert.equal((await visitor.request(`${route}/like`, { method: "DELETE" })).status, 401);
  assert.equal((await visitor.request(route, { method: "PATCH", body: { title: "Hacked" } })).status, 401);
  assert.equal((await visitor.request(`${route}/items`, { method: "POST", raw: true, body: png })).status, 401);
  assert.equal((await visitor.request(route, { method: "DELETE" })).status, 401);
  const session = await visitor.request("/gallery/api/session");
  const forged = `ldq_visitor=${"a".repeat(64)}.${"b".repeat(64)}`;
  const validSessionCookie = visitorSession.headers.getSetCookie().find((value) => value.startsWith("ldq_gallery=")).split(";")[0];
  assert.equal((await visitor.request(`${route}/view`, { method: "POST", headers: { Cookie: `${validSessionCookie}; ${forged}`, "X-CSRF-Token": session.data.csrf } })).status, 401);
  await owner.request(route, { method: "DELETE" });
  assert.equal((await visitor.request(`${route}/like`, { method: "POST", body: { liked: true } })).status, 404);
});

test("existing collections and media survive automatic reaction-table creation", async (t) => {
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const app = await fixture(t, { prepare: async (dataDir) => {
    const legacy = new DatabaseSync(path.join(dataDir, "gallery.sqlite"));
    legacy.exec(`CREATE TABLE sets (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, cover_id TEXT, created INTEGER NOT NULL);
      CREATE TABLE items (id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE, filename TEXT NOT NULL, kind TEXT NOT NULL, caption TEXT NOT NULL, created INTEGER NOT NULL);`);
    legacy.prepare("INSERT INTO sets VALUES (?, 'Existing collection', 'Keep this description', ?, 1)").run(id, id);
    legacy.prepare("INSERT INTO items VALUES (?, ?, 'existing.png', 'image', 'Existing caption', 1)").run(id, id);
    legacy.close();
  } });
  const visitor = app.client();
  await visitor.request("/gallery/api/session");
  const set = (await visitor.request("/gallery/api/sets")).data.sets[0];
  assert.equal(set.title, "Existing collection");
  assert.equal(set.cover_id, id);
  assert.equal(set.items[0].caption, "Existing caption");
  assert.equal(set.likes, 0);
  assert.equal(set.views, 0);
  assert.equal(set.items[0].views, 0);
  assert.equal((await visitor.request(`/gallery/api/items/${id}/like`, { method: "POST", body: { liked: true } })).data.likes, 1);
  await app.restart();
  assert.equal((await visitor.request("/gallery/api/sets")).data.sets[0].items[0].likes, 1);
});
