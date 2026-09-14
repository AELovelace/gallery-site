import * as oidc from 'openid-client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const token = () => randomBytes(32).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const cookie = (request, name) => (request.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1);

export function initAccounts(db) { // Adds stable identities without assigning old password sessions any new account privileges.
  db.exec(`CREATE TABLE IF NOT EXISTS gallery_users (id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('viewer','contributor','owner')), disabled INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_login INTEGER NOT NULL, UNIQUE(issuer,subject));
    CREATE TABLE IF NOT EXISTS gallery_logins (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS user_audit (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL, created INTEGER NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'user_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES gallery_users(id); DELETE FROM sessions;');
  }
  if (!db.prepare('PRAGMA table_info(sets)').all().some(c => c.name === 'owner_id')) db.exec('ALTER TABLE sets ADD COLUMN owner_id TEXT REFERENCES gallery_users(id)');
}

export function bindOwner(db, issuer, subject, username) { // Operator-only migration binds the verified identity subject and claims existing unowned collections atomically.
  if (!subject || !username) throw Error('An exact identity subject and username are required.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare("SELECT * FROM gallery_users WHERE role='owner'").get();
    if (existing && (existing.issuer !== issuer || existing.subject !== subject)) throw Error('A different gallery owner is already bound.');
    const id = db.prepare('SELECT id FROM gallery_users WHERE issuer=? AND subject=?').get(issuer, subject)?.id || randomUUID();
    db.prepare("INSERT INTO gallery_users VALUES (?,?,?,?,'owner',0,?,0) ON CONFLICT(issuer,subject) DO UPDATE SET role='owner',disabled=0,username=excluded.username").run(id, issuer, subject, username, Date.now());
    db.prepare('UPDATE sets SET owner_id=? WHERE owner_id IS NULL').run(id);
    db.prepare("INSERT INTO user_audit(actor,target,action,created) VALUES ('operator',?,'bind owner and claim legacy collections',?)").run(id, Date.now());
    db.exec('COMMIT');
    return id;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function createIdentity(db, { origin, issuer, clientId }) { // Uses OIDC code flow with PKCE S256, signed ID-token verification, state and nonce validation.
  const issuerUrl = new URL(issuer);
  if (issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash || (issuerUrl.protocol !== 'https:' && !(issuerUrl.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(issuerUrl.hostname)))) throw Error('Use an HTTPS identity issuer (HTTP is allowed only on loopback).');
  const secure = origin.startsWith('https:');
  if (secure && issuerUrl.protocol !== 'https:') throw Error('A public gallery requires an HTTPS identity issuer.');
  const sessionName = secure ? '__Secure-ldq_gallery' : 'ldq_gallery';
  const loginName = secure ? '__Secure-ldq_gallery_login' : 'ldq_gallery_login';
  const cookieValue = (name, value, age) => `${name}=${value}; Path=/gallery/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const append = (response, value) => response.setHeader('Set-Cookie', [...(response.getHeader('Set-Cookie') || []), value]);
  let configuration;
  const configured = () => configuration ||= oidc.discovery(issuerUrl, clientId, undefined, oidc.None(), { execute: [...(issuerUrl.protocol === 'http:' ? [oidc.allowInsecureRequests] : []), oidc.enableNonRepudiationChecks] }).catch(error => { configuration = null; throw error; });
  function session(request) { // Reads the current role on every request so revocations do not wait for cookie expiry.
    const value = cookie(request, sessionName);
    if (!/^[a-f0-9]{64}$/.test(value || '')) return null;
    const row = db.prepare('SELECT s.*,u.username,u.role,u.disabled FROM sessions s LEFT JOIN gallery_users u ON u.id=s.user_id WHERE s.id=? AND s.expires>?').get(digest(value), Date.now());
    if (!row || row.disabled) return null;
    return { ...row, authenticated: Boolean(row.user_id), can_post: ['owner','contributor'].includes(row.role), admin: row.role === 'owner' };
  }
  function createSession(response, userId = null) { // Rotates credentials after login; only opaque HttpOnly cookies reach the browser.
    const value = token(), csrf = token(), lifetime = 3600;
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    if (db.prepare('SELECT count(*) AS total FROM sessions').get().total >= 10000) fail(503, 'The gallery is busy. Please try again.');
    db.prepare('INSERT INTO sessions(id,csrf,authenticated,expires,user_id) VALUES (?,?,?,?,?)').run(digest(value), csrf, userId ? 1 : 0, Date.now() + lifetime * 1000, userId);
    append(response, cookieValue(sessionName, value, lifetime));
    return { authenticated: false, csrf, can_post: false, admin: false, user: null };
  }
  function summary(current) { // Exposes only the gallery profile and permissions, never tokens or identity-provider credentials.
    return { authenticated: current.authenticated, csrf: current.csrf, can_post: current.can_post, admin: current.admin, user: current.user_id ? { id: current.user_id, username: current.username, role: current.role } : null };
  }
  function logout(request, response) {
    const current = session(request);
    if (current) db.prepare('DELETE FROM sessions WHERE id=?').run(current.id);
    append(response, cookieValue(sessionName, '', 0));
  }
  async function route(request, response, action) {
    if (request.method !== 'GET') fail(405, 'Method not allowed.');
    const redirect = destination => { response.writeHead(303, { Location: destination, 'Cache-Control': 'no-store' }); response.end(); };
    if (action === 'login' || action === 'register') {
      const config = await configured();
      db.prepare('DELETE FROM gallery_logins WHERE expires<=?').run(Date.now());
      if (db.prepare('SELECT count(*) AS total FROM gallery_logins').get().total >= 2000) fail(429, 'Please try signing in again shortly.');
      const old = cookie(request, loginName);
      if (old) db.prepare('DELETE FROM gallery_logins WHERE id=?').run(digest(old));
      const attempt = token(), verifier = oidc.randomPKCECodeVerifier(), state = oidc.randomState(), nonce = oidc.randomNonce();
      db.prepare('INSERT INTO gallery_logins VALUES (?,?,?)').run(digest(attempt), JSON.stringify({ verifier, state, nonce }), Date.now() + 600000);
      append(response, cookieValue(loginName, attempt, 600));
      return redirect(oidc.buildAuthorizationUrl(config, { redirect_uri: origin + '/gallery/auth/callback', scope: 'openid profile', code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce, ...(action === 'register' ? { screen_hint: 'signup', prompt: 'login' } : {}) }).href);
    }
    if (action !== 'callback') fail(404, 'Sign-in route not found.');
    const attempt = cookie(request, loginName);
    append(response, cookieValue(loginName, '', 0));
    const row = attempt && db.prepare('DELETE FROM gallery_logins WHERE id=? RETURNING *').get(digest(attempt));
    if (!row || row.expires <= Date.now()) fail(400, 'This sign-in expired or was already used. Return to the gallery and sign in again.');
    try {
      const saved = JSON.parse(row.payload), config = await configured();
      const tokens = await oidc.authorizationCodeGrant(config, new URL(request.url, origin), { pkceCodeVerifier: saved.verifier, expectedState: saved.state, expectedNonce: saved.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims?.sub) throw Error('Missing identity.');
      const profile = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
      const username = typeof profile.preferred_username === 'string' ? profile.preferred_username.slice(0, 100) : 'LiDollID member';
      db.prepare('INSERT INTO gallery_users(id,issuer,subject,username,created,last_login) VALUES (?,?,?,?,?,?) ON CONFLICT(issuer,subject) DO UPDATE SET username=excluded.username,last_login=excluded.last_login').run(randomUUID(), claims.iss, claims.sub, username, Date.now(), Date.now());
      const user = db.prepare('SELECT * FROM gallery_users WHERE issuer=? AND subject=?').get(claims.iss, claims.sub);
      if (user.disabled) fail(403, 'This account cannot access the gallery.');
      logout(request, response);
      createSession(response, user.id);
      return redirect('/gallery/');
    } catch (error) {
      if (error.status === 403) throw error;
      fail(400, 'LiDollID sign-in could not be verified. Return to the gallery and try again.');
    }
  }
  return { session, createSession, summary, logout, route };
}
