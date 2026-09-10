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
Node version, installs the app/unit, prompts for owner credentials on first use,
adds firewalld rules for the proxy, and starts/checks the service.

## Repository and runtime

This repository is separate from the GameMaker project. It includes its own theme
at `web/gallery/theme.css`; nginx forwards every gallery asset/API/media request
to this service. The main website only needs a link to `/gallery/`. Its existing
game, TLS setup, and other routes remain independently deployed.

Production requires Node 24.14+ with built-in SQLite. No npm dependencies are
needed to run the gallery. Fedora uses the explicit `/usr/bin/node-24` binary.
There is no default owner password or public registration. Run owner setup on
the backend host; do not put a password in a config file or Git.

For local development with Node 24.14+:

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

JPG, PNG, GIF, WebP, MP4 and WebM are accepted, up to 250 MB each by default.
Videos need browser-playable codecs; no transcoding is provided. Video thumbnails
use a play symbol. Photos retain their original resolution and metadata, so
upload versions suitable for public sharing. File-signature checks exclude
HTML/SVG and unrecognized formats but do not fully decode or repair media.
The gallery does not generate resized photo thumbnails or provide private drafts.

## Authentication and persistence

Mutations require an authenticated server session, exact origin and CSRF checks.
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
python3 python/package_release.py
```

The API tests use temporary databases and verify CRUD/persistence, authentication,
CSRF/origin checks, sessions, rate limits, upload validation, private-file
isolation and video byte ranges. Puppeteer is a development dependency used only
for the browser checks; it downloads Chromium. Browser tests create their own
image/video fixtures and save screenshots in ignored `output/gallery/`.

The release command creates `dist/lidoll-gallery-fedora.tar.gz` plus a SHA-256
file. It packages an explicit list of production files, with Linux line endings,
and excludes Git history, credentials, uploaded content, the game, and npm modules.
Check installer syntax with `bash -n server/gallery/fedora/install.sh` before
packaging deployment changes. Real Fedora/SELinux/nginx validation is performed
on the target hosts as described in [FEDORA.md](FEDORA.md).
