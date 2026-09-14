import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { testIdentity } from "./test-identity.mjs";
import { bindOwner } from "./identity.mjs";
import { createGalleryServer, passwordRecord } from "./server.mjs";

const origin = "http://localhost:8787";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "lidoll-gallery-test-"));
  await writeFile(path.join(dataDir, "admin.json"), JSON.stringify(await passwordRecord("doll", "test-password-for-gallery")));
  if (options.prepare) await options.prepare(dataDir); // Allows an actual pre-update database to be opened by the new server in migration coverage.
  const identity = await testIdentity();
  t.after(() => identity.close());
  let server;
  let base;
  async function start() {
    server = createGalleryServer({ dataDir, origin, maxUploadMB: 1, issuer: options.origin?.startsWith("https:") ? "https://auth.example" : identity.issuer, ...options });
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
  const binding = new DatabaseSync(path.join(dataDir, "gallery.sqlite"));
  if (options.bindOwner !== false) bindOwner(binding, identity.issuer, "subject-lidoll", "lidoll"); binding.close();
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
      authHeaders: () => ({ Cookie: [...cookies].map(([name,value])=>name+"="+value).join("; "), Origin: origin, "X-CSRF-Token": csrf }),
      async request(route, { method = "GET", body, headers = {}, raw = false } = {}) {
        const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
        const response = await fetch(`${base}${route}`, { method, redirect: "manual", headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method !== "GET" ? { Origin: origin, "X-CSRF-Token": csrf } : {}), ...(body && !raw ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
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
      async login(user = 'lidoll') {
        identity.user = user;
        await this.request('/gallery/api/session');
        const start = await this.request('/gallery/auth/login');
        assert.equal(start.status,303);
        const authorized = await fetch(start.headers.get('location'), {redirect:'manual'});
        const callback = new URL(authorized.headers.get('location'));
        const result = await this.request(callback.pathname + callback.search);
        assert.equal(result.status,303,JSON.stringify(result.data));
        return (await this.request('/gallery/api/session')).data;
      },
    };
  }
  return { client, dataDir, identity, get base() { return base; }, restart: async () => { await stop(); await start(); } };
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
  assert.equal((await visitor.request(`/gallery/media/${itemId}`)).status, 401);
  assert.equal((await visitor.request(`/gallery/download/${itemId}`)).status, 401);
  assert.equal((await visitor.request(`/gallery/preview/${itemId}`)).status, 200);
  await visitor.login("reader");
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

test("public MP4 and WebM playback supports seeking while downloads and original photos require an enabled account", async (t) => {
  const app = await fixture(t), owner = app.client(), visitor = app.client(), reader = app.client();
  await owner.login();
  const member = await reader.login("reader");
  const set = (await owner.request("/gallery/api/sets", { method: "POST", body: { title: "Public films" } })).data.id;
  const photo = (await owner.request(`/gallery/api/sets/${set}/items`, { method: "POST", raw: true, body: png })).data.id;
  const videos = [];
  for (const [type, signature] of [["video/mp4", "000000186674797069736f6d0000020069736f6d69736f32"], ["video/webm", "1a45dfa37765626d0000000000"]]) {
    const bytes = Buffer.concat([Buffer.from(signature, "hex"), Buffer.alloc(100)]);
    const upload = await owner.request(`/gallery/api/sets/${set}/items`, { method: "POST", raw: true, body: bytes });
    assert.equal(upload.status, 201);
    const media = `/gallery/media/${upload.data.id}`, download = `/gallery/download/${upload.data.id}`;
    videos.push({ media, download });
    const playback = await visitor.request(media); // Exercises playback without even creating a visitor or login session.
    assert.equal(playback.status, 200);
    assert.equal(playback.headers.get("content-type"), type);
    assert.equal(playback.headers.get("content-disposition"), null);
    assert.equal(playback.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(playback.bytes, bytes);
    const head = await visitor.request(media, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), bytes.length);
    assert.equal(head.bytes.length, 0);
    for (const [range, start, end] of [["bytes=4-11", 4, 11], ["bytes=-8", bytes.length - 8, bytes.length - 1]]) {
      const part = await visitor.request(media, { headers: { Range: range } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get("content-range"), `bytes ${start}-${end}/${bytes.length}`);
      assert.deepEqual(part.bytes, bytes.subarray(start, end + 1));
    }
    assert.equal((await visitor.request(media, { headers: { Range: "bytes=9999-" } })).status, 416);
    const saved = await reader.request(download);
    assert.equal(saved.status, 200);
    assert.match(saved.headers.get("content-disposition"), /^attachment;/);
    assert.deepEqual(saved.bytes, bytes);
  }
  await owner.request(`/gallery/api/users/${member.user.id}`, { method: "PATCH", body: { role: "viewer", disabled: true } });
  for (const client of [visitor, reader]) {
    for (const options of [{}, { method: "HEAD" }, { headers: { Range: "bytes=0-2" } }]) {
      assert.equal((await client.request(`/gallery/media/${photo}`, options)).status, 401);
      assert.equal((await client.request(`/gallery/download/${photo}`, options)).status, 401);
      for (const video of videos) assert.equal((await client.request(video.download, options)).status, 401);
    } // Anonymous and revoked sessions cannot use HEAD or Range to bypass download/photo authentication.
    for (const video of videos) assert.equal((await client.request(video.media)).status, 200);
  }
  const items = (await visitor.request("/gallery/api/sets")).data.sets[0].items;
  assert.ok(items.every(item => item.views === 0)); // Streaming and seeking alone never inflate view counts.
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
  const exactLimit = Buffer.alloc(1024 * 1024);
  png.copy(exactLimit);
  assert.equal((await client.request(uploadRoute, { method: "POST", raw: true, body: exactLimit })).status, 201); // Accepts a file exactly at the configured boundary while the extra-byte case above is rejected.
  const otherId = (await client.request("/gallery/api/sets", { method: "POST", body: { title: "Other" } })).data.id;
  const itemId = (await client.request(`/gallery/api/sets/${otherId}/items`, { method: "POST", raw: true, body: png })).data.id;
  assert.equal((await client.request(`/gallery/api/sets/${id}`, { method: "PATCH", body: { cover_id: itemId } })).status, 400);
});

test("the default per-file upload limit advertised to the browser is 1 GiB", async (t) => {
  const savedLimit = process.env.GALLERY_MAX_UPLOAD_MB;
  let app;
  try {
    delete process.env.GALLERY_MAX_UPLOAD_MB;
    app = await fixture(t, { maxUploadMB: undefined }); // Exercises the production default instead of the fixture's usual 1 MiB override.
  } finally {
    if (savedLimit === undefined) delete process.env.GALLERY_MAX_UPLOAD_MB;
    else process.env.GALLERY_MAX_UPLOAD_MB = savedLimit;
  }
  assert.equal((await app.client().request("/gallery/api/session")).data.max_upload_mb, 1024);
});

test("login rate limits survive sessions and public routes do not expose storage", async (t) => {
  const app = await fixture(t);
  const client = app.client();
  await client.request("/gallery/api/session");
  const db = new DatabaseSync(path.join(app.dataDir,'gallery.sqlite'));
  const insert = db.prepare('INSERT INTO gallery_logins VALUES (?, ?, ?)');
  for(let i=0;i<2000;i++) insert.run('attempt-'+i,'{}',Date.now()+600000);
  db.close();
  assert.equal((await client.request('/gallery/auth/login')).status,429);
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

test("account likes are idempotent, removable and persistent; daily views deduplicate separately for sets and media", async (t) => {
  const app = await fixture(t);
  const owner = app.client();
  const first = app.client();
  const second = app.client();
  await owner.login();
  const set = (await owner.request("/gallery/api/sets", { method: "POST", body: { title: "Reactions" } })).data.id;
  const item = (await owner.request(`/gallery/api/sets/${set}/items`, { method: "POST", body: png, raw: true })).data.id;
  await first.login("first");
  await second.login("second");
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
  await second.login("second");
  await second.request("/gallery/api/logout", { method: "POST" });
  await second.request("/gallery/api/session");
  assert.equal((await second.request("/gallery/api/sets")).data.sets[0].liked, false);
  await second.login("second");
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
  assert.equal((await visitor.request(`${route}/like`, { method: "POST", body: { liked: "yes" } })).status, 401);
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
  await visitor.login("reader");
  assert.equal((await visitor.request(`/gallery/api/items/${id}/like`, { method: "POST", body: { liked: true } })).data.likes, 1);
  await app.restart();
  assert.equal((await visitor.request("/gallery/api/sets")).data.sets[0].items[0].likes, 1);
});

test('viewer, contributor and owner permissions are isolated and revocations apply immediately', async t => {
  const app=await fixture(t), owner=app.client(), contributor=app.client(), other=app.client();
  const admin=await owner.login();const member=await contributor.login('contributor');const second=await other.login('other');
  const request={method:'POST',body:{title:'Owned set'}};
  assert.equal((await contributor.request('/gallery/api/sets',request)).status,403);
  assert.equal((await contributor.request('/gallery/api/users')).status,403);
  const grant={method:'PATCH',body:{role:'contributor',disabled:false}};
  assert.equal((await contributor.request('/gallery/api/users/'+member.user.id,grant)).status,403);
  assert.equal((await owner.request('/gallery/api/users/'+member.user.id,{...grant,headers:{'X-CSRF-Token':'wrong'}})).status,403);
  assert.equal((await owner.request('/gallery/api/users/'+member.user.id,grant)).status,200);
  const set=(await contributor.request('/gallery/api/sets',request)).data.id;
  const item=(await contributor.request(`/gallery/api/sets/${set}/items`,{method:'POST',raw:true,body:png})).data.id;
  assert.equal((await owner.request('/gallery/api/users/'+second.user.id,grant)).status,200);
  for(const [route,method,body] of [[`sets/${set}`,'PATCH',{title:'Stolen'}],[`sets/${set}`,'DELETE',{}],[`items/${item}`,'PATCH',{caption:'Changed'}],[`items/${item}`,'DELETE',{}]]) assert.equal((await other.request('/gallery/api/'+route,{method,body})).status,403);
  assert.equal((await other.request(`/gallery/api/sets/${set}/items`,{method:'POST',raw:true,body:png})).status,403);
  const download=await other.request('/gallery/download/'+item);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.equal(download.headers.get('cache-control'),'private, no-store');
  const users=await owner.request('/gallery/api/users?q=contributor');assert.equal(users.data.users.length,1);assert.equal(users.data.users[0].collections,1);assert.equal(users.headers.get('cache-control'),'no-store');
  assert.equal((await owner.request('/gallery/api/users/'+admin.user.id,{method:'PATCH',body:{role:'viewer',disabled:true}})).status,403);
  await owner.request('/gallery/api/users/'+member.user.id,{method:'PATCH',body:{role:'viewer',disabled:false}});
  assert.equal((await contributor.request(`/gallery/api/items/${item}`,{method:'PATCH',body:{caption:'Revoked'}})).status,403);
  assert.equal((await owner.request(`/gallery/api/items/${item}`,{method:'PATCH',body:{caption:'Owner edit'}})).status,200);
  await owner.request('/gallery/api/users/'+member.user.id,{method:'PATCH',body:{role:'viewer',disabled:true}});
  assert.equal((await contributor.request('/gallery/media/'+item)).status,401);
  assert.equal((await contributor.request('/gallery/download/'+item,{method:'HEAD'})).status,401);
  assert.equal((await contributor.request('/gallery/media/'+item,{headers:{Range:'bytes=0-2'}})).status,401);
  assert.equal((await contributor.request('/gallery/api/session')).data.authenticated,false);
  const db=new DatabaseSync(path.join(app.dataDir,'gallery.sqlite'));
  assert.ok(db.prepare('SELECT count(*) AS n FROM user_audit').get().n>=5);db.close();
});

test('OIDC validates state, nonce, issuer, audience, signature, userinfo subject, expiry and callback replay', async t => {
  const app=await fixture(t),client=app.client();
  async function attempt(changeURL) {
    await client.request('/gallery/api/session');
    const start=await client.request('/gallery/auth/login');assert.equal(start.status,303);
    const authorization=await fetch(start.headers.get('location'),{redirect:'manual'});
    const callback=new URL(authorization.headers.get('location'));
    changeURL?.(callback);
    return {callback:callback.pathname+callback.search,result:await client.request(callback.pathname+callback.search)};
  }
  assert.equal((await attempt(url=>url.searchParams.set('state','wrong'))).result.status,400);
  for(const claims of [{nonce:'wrong'},{iss:'https://wrong.example'},{aud:'wrong-client'},{exp:1}]) {app.identity.claims=claims;assert.equal((await attempt()).result.status,400);}
  app.identity.claims={};app.identity.badSignature=true;assert.equal((await attempt()).result.status,400);app.identity.badSignature=false;
  app.identity.profileSubject='different-account';assert.equal((await attempt()).result.status,400);app.identity.profileSubject=null;
  const completed=await attempt();assert.equal(completed.result.status,303);
  assert.equal((await client.request(completed.callback)).status,400);
  const register=await client.request('/gallery/auth/register');const destination=new URL(register.headers.get('location'));
  assert.equal(destination.searchParams.get('screen_hint'),'signup');assert.equal(destination.searchParams.get('code_challenge_method'),'S256');assert.equal(destination.searchParams.get('redirect_uri'),origin+'/gallery/auth/callback');
  const stranger=app.client();assert.equal((await stranger.request(completed.callback)).status,400);
});

test('likes follow the same account across browsers and never transfer between account switches', async t => {
  const app=await fixture(t),owner=app.client(),a=app.client(),b=app.client();await owner.login();
  const id=(await owner.request('/gallery/api/sets',{method:'POST',body:{title:'Account likes'}})).data.id;
  await a.login('shared');await b.login('shared');
  await a.request(`/gallery/api/sets/${id}/like`,{method:'POST',body:{liked:true}});
  const result=await b.request(`/gallery/api/sets/${id}/like`,{method:'POST',body:{liked:true}});assert.equal(result.data.likes,1);
  await b.login('different');const sets=(await b.request('/gallery/api/sets')).data.sets;assert.equal(sets[0].liked,false);assert.equal(sets[0].likes,1);
});

test('owner migration claims legacy collections once and cannot be stolen by an identical display name', async t => {
  const app=await fixture(t);const db=new DatabaseSync(path.join(app.dataDir,'gallery.sqlite'));
  const owner=db.prepare("SELECT * FROM gallery_users WHERE role='owner'").get();
  db.prepare("INSERT INTO sets(id,title,description,created) VALUES ('legacy','Old collection','',1)").run();
  assert.equal(bindOwner(db,app.identity.issuer,'subject-lidoll','lidoll'),owner.id);
  assert.equal(db.prepare("SELECT owner_id FROM sets WHERE id='legacy'").get().owner_id,owner.id);
  assert.throws(()=>bindOwner(db,app.identity.issuer,'attacker','lidoll'),/different gallery owner/);
  db.close();
  app.identity.profileName='lidoll';app.identity.user='imposter';const visitor=app.client();await visitor.login('imposter');
  assert.equal((await visitor.request('/gallery/api/session')).data.admin,false);
});

test('public previews are reduced, metadata-free derivatives and cannot reveal original image or video bytes', async t => {
  const {default:sharp}=await import('sharp');
  const app=await fixture(t),owner=app.client(),visitor=app.client();await owner.login();
  const id=(await owner.request('/gallery/api/sets',{method:'POST',body:{title:'Previews'}})).data.id;
  const original=await sharp({create:{width:1600,height:1000,channels:3,background:'#e979b3'}}).withMetadata({exif:{IFD0:{Artist:'Private metadata'}}}).jpeg().toBuffer();
  const item=(await owner.request(`/gallery/api/sets/${id}/items`,{method:'POST',raw:true,body:original})).data.id;
  const responses=await Promise.all(Array.from({length:5},()=>visitor.request('/gallery/preview/'+item)));
  for(const response of responses){assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/webp');const metadata=await sharp(response.bytes).metadata();assert.equal(metadata.width,480);assert.equal(metadata.height,300);assert.equal(metadata.exif,undefined);assert.notDeepEqual(response.bytes,original);}
  assert.deepEqual((await owner.request('/gallery/download/'+item)).bytes,original);
  const brokenVideo=Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex'),Buffer.alloc(100)]);
  const video=(await owner.request(`/gallery/api/sets/${id}/items`,{method:'POST',raw:true,body:brokenVideo})).data.id;
  const fallback=await visitor.request('/gallery/preview/'+video);assert.equal(fallback.headers.get('content-type'),'image/svg+xml');assert.notDeepEqual(fallback.bytes,brokenVideo);
  await owner.request('/gallery/api/sets/'+id,{method:'DELETE'});
  assert.equal((await visitor.request('/gallery/preview/'+item)).status,404);
  assert.deepEqual(await readdir(path.join(app.dataDir,'previews')),[]);
});

test('revoking contributor access during an upload rejects the commit and cleans temporary bytes', async t => {
  const {request}=await import('node:http');
  const app=await fixture(t),owner=app.client(),poster=app.client();await owner.login();const user=await poster.login('poster');
  const permissions='/gallery/api/users/'+user.user.id;
  await owner.request(permissions,{method:'PATCH',body:{role:'contributor',disabled:false}});
  const set=(await poster.request('/gallery/api/sets',{method:'POST',body:{title:'Interrupted upload'}})).data.id;
  let upload;
  const completed=new Promise((resolve,reject)=>{
    upload=request(app.base+`/gallery/api/sets/${set}/items`,{method:'POST',headers:{...poster.authHeaders(),'Content-Type':'image/png'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
    upload.on('error',reject);upload.write(png.subarray(0,32));
  });
  t.after(()=>upload.destroy());
  for(let n=0;n<100;n++){if((await readdir(path.join(app.dataDir,'uploads'))).some(name=>name.endsWith('.part')))break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.ok((await readdir(path.join(app.dataDir,'uploads'))).some(name=>name.endsWith('.part')));
  await owner.request(permissions,{method:'PATCH',body:{role:'viewer',disabled:false}});
  upload.end(png.subarray(32));assert.equal(await completed,403);
  assert.deepEqual(await readdir(path.join(app.dataDir,'uploads')),[]);
  assert.equal((await owner.request('/gallery/api/sets')).data.sets[0].items.length,0);
});

test('owner setup resolves the exact enabled identity from a read-only auth database and is idempotent', async t => {
  const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const app=await fixture(t,{bindOwner:false});
  const authFile=path.join(app.dataDir,'test-auth.sqlite');const auth=new DatabaseSync(authFile);
  auth.exec('CREATE TABLE accounts(id TEXT,username TEXT,disabled INTEGER)');
  auth.prepare('INSERT INTO accounts VALUES (?,?,?)').run('permanent-owner','lidoll',0);auth.close();
  const run=promisify(execFile);
  const args=['server/gallery/setup.mjs','bind-owner','--auth-db',authFile,'--username','lidoll'];
  const options={env:{...process.env,GALLERY_DATA_DIR:app.dataDir,GALLERY_OIDC_ISSUER:'https://auth.sadgirlsclub.wtf'}};
  const result=await run(process.execPath,args,options);assert.match(result.stdout,/owner bound.*lidoll/);
  await run(process.execPath,args,options);
  await assert.rejects(run(process.execPath,[...args.slice(0,-1),'lid0ll'],options),error=>/exactly one enabled/.test(error.stderr));
  const db=new DatabaseSync(path.join(app.dataDir,'gallery.sqlite'));
  const users=db.prepare("SELECT * FROM gallery_users WHERE role='owner'").all();assert.equal(users.length,1);assert.equal(users[0].subject,'permanent-owner');db.close();
  const check=new DatabaseSync(authFile,{readOnly:true});assert.deepEqual({...check.prepare('SELECT * FROM accounts').get()},{id:'permanent-owner',username:'lidoll',disabled:0});check.close();
});
