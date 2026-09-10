# LiDOLL gallery

An independent photo/video gallery for **https://lidoll.dev/gallery/**, styled
to match the main LiDOLL site. The owner can log in, manage collections, upload
multiple files, edit captions, and choose covers. Saved content is public.

**Fedora deployment:** follow [FEDORA.md](FEDORA.md). The prepared layout is:

```text
https://lidoll.dev/gallery/ → nginx 10.1.1.20 → Node 10.1.1.23:8787
```

The service runs under systemd as `lidoll-gallery`, with root-owned application
files in `/opt/lidoll-gallery` and private persistent data in
`/var/lib/lidoll-gallery`. The Fedora installer creates the account, checks the
existing Node version (24.9+), installs missing deployment dependencies and
the app/unit, prompts for owner credentials on first use,
adds firewalld rules for the proxy, and starts/checks the service.
Tests and owner setup run from `/opt/lidoll-gallery` as the service account,
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

The gallery's compatibility minimum is Node 24.9 with built-in SQLite. No npm dependencies are
needed to run the gallery. Fedora uses the explicit `/usr/bin/node-24` binary.
There is no default owner password or public registration. Run owner setup on
the backend host; do not put a password in a config file or Git.

The installer reuses `/usr/bin/node-24` when present and installs `nodejs24`
only when that binary is missing. It does not request a Node upgrade or change
the default `node` command. Node 24.9.0 passes the API suite; keep runtime security
updates and Fedora maintenance on the host's normal maintenance schedule.

For local development with Node 24.9+:

```sh
node server/gallery/setup.mjs
node server/gallery/server.mjs
```

Open `http://localhost:8787/gallery/`. Local storage defaults to the ignored
`gallery-data/` folder. In production, configure the environment using the
included `gallery.env.example`. A static-only host cannot process login/uploads.
On Windows, `ps/start_gallery.ps1` also supports local or LAN startup.

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
Videos need browser-playable codecs; no transcoding is provided. MP4 and WebM
cards and video collection covers show a still frame with a play overlay. The
viewer uses the same frame as its poster before playback. Previews are created
in the browser for both existing and new uploads, near the beginning of each
video; no re-upload or server-side video tools are needed. Frames load as cards
approach the viewport, with at most two decoders running and a 64-frame page
cache. Preview requests do not count as views or start playback. If a browser
cannot decode a video, or loading times out, the play overlay remains usable.
Previews are regenerated after a page reload and are not saved on the server.
Photos retain their original resolution and metadata, so
upload versions suitable for public sharing. File-signature checks exclude
HTML/SVG and unrecognized formats but do not fully decode or repair media.
The gallery does not generate resized photo thumbnails or provide private drafts.

## Views and likes

Collections and individual photos/videos show public view and like totals.
Opening a collection or its media viewer records one view per browser per UTC
day. Browsing thumbnails, reloading the collection list, or seeking a video does
not add views. Views count opens, including the owner's, rather than completed
video plays or unique people. Collections and their media have separate totals.

Visitors can like without an owner account. Each browser can have one like per
collection or file; clicking again removes that like. Likes persist across page
reloads, owner login/logout, and server restarts. A signed, HttpOnly first-party
visitor cookie lasts one year and identifies the browser; no fingerprint or IP
address is stored in reaction records. Clearing cookies, using another browser,
or cookie expiry creates a new identity, so these are lightweight community
counts, not fraud-proof analytics. Browsers blocking cookies can still browse,
but cannot save reactions. An expired session asks the visitor to refresh.

Counts and deduplication records are stored in SQLite, covered by its existing
backup, and removed when their collection/file is deleted. Existing installations
gain the new tables automatically at startup, with existing content starting at
zero. Owner-password resets do not reset reactions or visitor identities.

## Authentication and persistence

Content edits require an owner-authenticated session, exact origin and CSRF checks.
Public view/like writes require an anonymous session, a signed visitor cookie,
and the same origin/CSRF checks, without granting content-management permissions.
Production cookies are Secure, HttpOnly, and SameSite=Strict. Passwords use salted
scrypt hashes. Sessions last 12 hours and rotate at login; logout and password
reset revoke sessions. Login attempts are limited to 10 per 15 minutes per direct
peer plus a global cap. With this proxy layout, the proxy is the direct peer and
the limit is shared; forwarded client-IP headers are not trusted.

Back up the entire persistent data directory with the service stopped, or use
a consistent volume snapshot. This includes `admin.json`, `gallery.sqlite` and
any WAL/SHM files, plus `uploads/`. Do not copy only the live SQLite file. Restore
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
