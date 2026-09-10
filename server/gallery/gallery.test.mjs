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
    let cookie = "";
    let csrf = "";
    return {
      async request(route, { method = "GET", body, headers = {}, raw = false } = {}) {
        const response = await fetch(`${base}${route}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== "GET" ? { Origin: origin, "X-CSRF-Token": csrf } : {}), ...(body && !raw ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
        if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
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
  assert.match(session.headers.get("set-cookie"), /^__Secure-ldq_gallery=.*; Secure$/);
});
