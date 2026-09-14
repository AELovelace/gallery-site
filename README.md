# LiDOLL gallery

An independent photo/video gallery for **https://lidoll.dev/gallery/**, styled
to match the main LiDOLL site. The owner can log in, manage collections, upload
multiple files, edit captions, and choose covers. Previews are public; originals require LiDollID sign-in.

**Fedora deployment:** follow [FEDORA.md](FEDORA.md). The prepared layout is:

```text
https://lidoll.dev/gallery/ → nginx 10.1.1.20 → Node 10.1.1.23:8787
```

The service runs under systemd as `lidoll-gallery`, with root-owned application
files in `/opt/lidoll-gallery` and private persistent data in
`/var/lib/lidoll-gallery`. The Fedora installer creates the account, checks the
existing Node version (24.9+), installs missing deployment dependencies and
the app/unit and pinned runtime packages,
adds firewalld rules for the proxy, and starts/checks the service.
Tests run from `/opt/lidoll-gallery` as the service account,
so the source checkout can remain inside a private home directory.

On the Fedora backend, from an extracted release or this checkout, run:

```sh
sudo bash server/gallery/fedora/install.sh
```

The installer detects the LAN interface's firewall zone. Firewalld must already
be configured and running; see [FEDORA.md](FEDORA.md) for initial setup and the
separate nginx proxy steps. Use `--zone public` to require a particular zone, or
`--help` to display usage without making changes.
If another application owns port 8787, use `--port 8788` (or another free port).
The installer saves that port, configures its firewall rules and health check,
and prepares `/opt/lidoll-gallery/server/gallery/nginx-gallery.conf` with the
matching upstream. Copy that installed snippet to the proxy; later installs
reuse the saved port. See [changing the port](FEDORA.md#changing-the-gallery-port).

For later updates from a clean Git checkout with a tracking branch:

```sh
sudo bash server/gallery/fedora/update.sh
```

This pulls with `git pull --ff-only --no-rebase` as the checkout owner, tests
staged code, refreshes `/opt/lidoll-gallery`, and restarts the existing service.
Your port, upload limit, credentials, uploads, Node runtime, installed unit and
firewall settings are preserved. The previous app is retained for recovery.
See [updates](FEDORA.md#updates-backups-and-password-resets) for requirements
and failure recovery.

## Repository and runtime

This repository is separate from the GameMaker project. It includes its own theme
at `web/gallery/theme.css`; nginx forwards every gallery asset/API/media request
to this service. The main website only needs a link to `/gallery/`. Its existing
game, TLS setup, and other routes remain independently deployed.

The gallery requires Node 24.9+, the pinned runtime dependencies in package-lock.json (openid-client and sharp), and ffmpeg for video still previews. Fedora uses /usr/bin/node-24. Authentication is LiDollID authorization-code flow with PKCE S256; no gallery passwords or client secret are used.

For local development with Node 24.9+:

```sh
npm ci
node server/gallery/server.mjs
```

Open `http://localhost:8787/gallery/`. Local storage defaults to the ignored
`gallery-data/` folder. In production, configure the environment using the
included `gallery.env.example`. A static-only host cannot process login/uploads.
Register the exact local callback with a development identity issuer and set GALLERY_OIDC_ISSUER / GALLERY_OIDC_CLIENT_ID to use sign-in locally. On Windows, `ps/start_gallery.ps1` also supports local or LAN startup.

## Working with collections

1. Log in, choose **+ New set**, and save a title and description.
2. Choose multiple photos/videos, then **Upload to this set**. Progress is shown
   per file. Successful files stay saved if another fails; only unfinished files
   remain selected for retry.
3. Use **Caption**, **Make cover**, **Edit set**, or **Delete** to manage content.
   Captions also provide image descriptions for screen readers. Deletion is
   permanent after confirmation. Log out when finished.

JPG, PNG, GIF, WebP, MP4 and WebM are accepted, up to 1 GiB (1024 MiB) each by default.
The limit is per file, so a batch can exceed 1 GiB in total. Existing deployments
keep their saved limit: set `GALLERY_MAX_UPLOAD_MB=1024` in
`/etc/lidoll-gallery.env`, restart the gallery, and set nginx's
`client_max_body_size 1024m;` before validating/reloading nginx. Refresh the
gallery page to fetch the new limit. Alternatively, deploy with
`--max-upload-mb 1024` and copy the installed nginx snippet to the proxy.
Videos need browser-playable codecs for full playback. Public image previews are re-encoded as WebP, at most 480 by 480, with metadata stripped. Public video previews are single still frames generated with ffmpeg and resized by sharp. Existing uploads gain previews lazily; failed/unsupported decodes show a placeholder and never expose the original. Preview files live in the private data directory. These public previews can themselves be saved by visitors.

## LiDollID accounts and permissions

Sign-in and registration are available in the gallery. Register the public client **lidoll-gallery** with the exact callback **https://lidoll.dev/gallery/auth/callback** and token endpoint authentication method **none**. The default issuer is **https://auth.sadgirlsclub.wtf**. Full setup and the one-time **lidoll** owner migration are in [FEDORA.md](FEDORA.md#lidollid-registration-and-owner-migration).

- Viewers can browse, like and download originals after signing in.
- Contributors can create collections and upload, caption, change covers, or delete content in their own collections.
- The owner can manage every collection and open **Users** to grant/revoke contributor permission or disable gallery access. Accounts appear after their first gallery login. Search and pagination support larger member lists. Disabling an account revokes gallery sessions; it does not disable the shared LiDollID account or delete content. The owner cannot be disabled/demoted from this panel.

Original media, downloads, HEAD and byte-range requests require a current enabled account. They are served with private, no-store caching. The same upload restrictions apply to all contributors. Permission checks happen again before an upload commits, so revoking access during an upload takes effect. Owner migration uses the identity database's permanent subject, never a display-name match. Existing collections are retained and assigned to the owner.

## Views and likes

Public collection/media counts remain visible. Opening a collection or viewer counts one view per signed visitor cookie per UTC day, including signed-out visitors. Thumbnails, preview generation and video seeking do not add views.

Likes require LiDollID and are unique per account and target across browsers. Clicking again removes the account's like. Historic anonymous likes remain in totals without being reassigned to an account. The visitor cookie is still used for view deduplication, not account permissions. Reaction writes require same-origin and CSRF checks.

## Authentication and persistence

The OIDC client verifies the signed ID token, issuer, audience, state, nonce, PKCE and matching userinfo subject. Login attempts expire after ten minutes and are single use; application sessions expire after one hour and rotate at sign-in. Cookies are HttpOnly and Secure on HTTPS. Login/session cookies use SameSite=Lax for the identity-provider callback; visitor cookies use Strict. Gallery logout ends the gallery session; shared LiDollID sign-in may remain active. Disabling the identity centrally prevents future sign-ins; an existing gallery session lasts up to one hour unless revoked in Users.

Automatic schema migration retains uploaded content and existing view/like totals, and revokes legacy password sessions. The old admin.json is no longer used to authenticate. Permission changes and owner binding are audited in the gallery database. No science or wallet database is accessed.

Back up the entire persistent data directory with the service stopped, or use
a consistent volume snapshot. This includes `gallery.sqlite` and
any WAL/SHM files, plus `uploads/` and `previews/`. Legacy `admin.json` can be retained in backups but is no longer a credential. Do not copy only the live SQLite file. Restore
while stopped and preserve service-account ownership and private permissions.
Application updates do not replace this directory.

A killed upload can leave an unlisted `.part` file. Remove those only with the
service stopped. Files lacking database records are never served. Disk deletion
errors appear in the service log; deleted records immediately become inaccessible.

## Verification and release

```sh
node --test server/gallery/gallery.test.mjs
npm install
npm run test:browser
python3 python/test_fedora_update.py
python3 python/package_release.py
```

The API tests use temporary databases and verify CRUD/persistence, authentication,
CSRF/origin checks, sessions, rate limits, upload validation, private-file
isolation, video byte ranges, per-day view deduplication, idempotent likes/unlikes,
visitor persistence, and reaction cleanup. Puppeteer is a development dependency used only
for the browser checks; it downloads Chromium. Browser tests create their own
image, MP4 and WebM fixtures, check still-frame previews and video covers/posters,
and save screenshots in ignored `output/gallery/`.

The release command creates `dist/lidoll-gallery-fedora.tar.gz` plus a SHA-256
file. The installer, Git updater, and packager share the explicit production
allowlist in `server/gallery/runtime-files.txt`. Add new runtime assets there.
The updater tests use temporary local Git remotes and mocked host services to
check clean pulls, settings preservation, failed tests, and application recovery.
The release packages production files with Linux line endings,
and excludes Git history, credentials, uploaded content, the game, and npm modules.
Check both deployment scripts with `bash -n server/gallery/fedora/install.sh`
and `bash -n server/gallery/fedora/update.sh` before packaging deployment changes.
Real Fedora/SELinux/nginx validation is performed
on the target hosts as described in [FEDORA.md](FEDORA.md).
