# Fedora deployment

This guide targets a conventional, supported Fedora Server/Workstation host
(dnf + systemd), with the gallery on **10.1.1.23** and nginx on **10.1.1.20**.
It does not target Fedora Atomic/Silverblue. The proxy can stay on its existing
operating system; apply the Fedora proxy commands only if it also runs Fedora.

## 1. Copy the release to the gallery box

Copy `dist/lidoll-gallery-fedora.tar.gz` and its `.sha256` file to your home
directory on `10.1.1.23`, then run there:

```sh
sha256sum -c lidoll-gallery-fedora.tar.gz.sha256
tar -xzf lidoll-gallery-fedora.tar.gz
cd lidoll-gallery
```

Alternatively, clone the independent gallery repository into your home directory
once you have created a Git remote. Run installation from that checkout; the
installer copies runtime files into `/opt/lidoll-gallery`. No GameMaker checkout
or game assets are required.

## 2. Check the LAN firewall zone

On `10.1.1.23`:

```sh
ip -br -4 address
sudo firewall-cmd --get-active-zones
```

The installer detects the zone assigned to the interface holding `10.1.1.23`,
falling back to firewalld's default zone when the interface has no explicit zone.
You can require a particular zone with `--zone public`, for example. The installer
checks it against that interface and refuses a mismatch before installing packages.

If firewalld is not installed/running, install and start it after ensuring its
zone permits your existing SSH/management access:

```sh
sudo dnf install firewalld
sudo systemctl enable --now firewalld
sudo firewall-cmd --get-active-zones
```

Do not open 8787 globally. The installer adds destination-specific rich rules
allowing `10.1.1.20` and rejecting other sources to `10.1.1.23:8787`, in both the
runtime and permanent LAN-zone configuration. It does not reload the firewall or
replace other rules. If you use source-based zones or custom earlier-priority
policies, check those too: source zones can take precedence over interface zones.
Rule priority/zone behavior follows the [firewalld rich-language reference](https://firewalld.org/documentation/man-pages/firewalld.richlanguage.html).

## 3. Install and start the backend

From the extracted release or cloned repository on `10.1.1.23`:

```sh
sudo bash server/gallery/fedora/install.sh
```

Optionally append `--zone YOUR_LAN_ZONE` to require a specific firewall zone.
Run `bash server/gallery/fedora/install.sh --help` for usage; help needs no sudo
and makes no changes. Before installing packages, the installer checks the
host/IP, running firewalld, runtime/permanent zone availability, and whether
first-time owner setup has an interactive terminal. It then installs
Fedora packages, creates the `lidoll-gallery` service user, installs source files
and the systemd unit, runs the API tests, and starts the service. On first use,
it prompts for an owner username and a hidden password of at least 12 characters.
Existing credentials, collections, uploads, and environment settings are
preserved when reinstalling, except that `--port` explicitly changes `PORT`
and `--max-upload-mb` explicitly changes `GALLERY_MAX_UPLOAD_MB`.
The app source/unit are updated. A listener belonging to another process on
the selected port stops installation before services or app files are changed.

The installer changes its working directory to `/opt/lidoll-gallery` before
running tests or owner setup as `lidoll-gallery`. A private source directory
such as `/home/aedith/gallery-site` does not need to be accessible to that user.
Older installers can fail with `EACCES: permission denied, lstat` on the source
directory because Node's test discovery also inspects the inherited working
directory, even when given an absolute test filename. Copy the corrected
installer and rerun, or resume that older copy from the installed app directory:

```sh
cd /opt/lidoll-gallery
sudo bash /home/aedith/gallery-site/server/gallery/fedora/install.sh --zone FedoraServer
```

Use your actual source path and LAN zone. This workaround applies after the
failed installer has already created `/opt/lidoll-gallery`. Keep the permissions
on your home directory unchanged; tests still run as the service account.

The host must already have `iproute` and running, configured `firewalld` for
these checks. If either is missing, install it with `sudo dnf install iproute
firewalld`, then follow the firewall setup above before rerunning the installer.

The installer uses Fedora's `nodejs24` package and `/usr/bin/node-24`, independently
of `/usr/bin/node`. Fedora supports [versioned Node streams](https://developer.fedoraproject.org/tech/languages/nodejs/nodejs.html)
and documents the [versioned binary paths](https://fedoraproject.org/wiki/Changes/NodejsAlternativesSystem).
The compatibility minimum is Node 24.9 within the 24.x stream. The complete API
suite passes on upstream Node 24.9.0 on Windows; the installer also runs that
suite on the Fedora host's actual runtime. The gallery uses SQLite APIs already
present in [Node 24.9](https://nodejs.org/download/release/v24.9.0/docs/api/sqlite.html).
Node 12.9 cannot run this gallery: it lacks the built-in SQLite module.

An existing `/usr/bin/node-24` is reused without requesting a Node upgrade. If
that binary is absent, the installer requests the `nodejs24` package. Other
deployment packages are requested only if missing. Installing missing packages
may also install or update dependencies as required by DNF; review a host's
package dependencies separately when planning maintenance.

If an older installer rejects Node 24.9.0 with a "24.14+ is required" error,
copy the updated release and rerun its installer. That earlier minimum was
stricter than the APIs used by the gallery require; changing Fedora or the
default Node version is not necessary to resolve this particular error.
If runtime validation still fails, collect:

```sh
cat /etc/fedora-release
sudo dnf --refresh list --available nodejs24
dnf repolist
```

Keep runtime security updates and OS maintenance separate from compatibility
checks: passing gallery tests does not establish that an old runtime or OS has
current security fixes. Fedora 41 reached
[end of life on December 15, 2025](https://fedorapeople.org/groups/schedule/f-41/f-41-key-tasks.html).
Its repositories may remain at Node 24.9.0 after "Nothing to do." Plan OS
maintenance with the other applications on that machine; the gallery installer
does not perform OS upgrades or reboots.

Changing the default `node` command does
not change `/usr/bin/node-24`, which is used by both the installer and systemd.
The installer stops before copying app files or stopping the gallery if this
check fails. Node 24's built-in SQLite may print an experimental warning; that
warning alone does not indicate failure.

The installed layout is:

| Purpose | Path/value |
| --- | --- |
| App source, owned by root | `/opt/lidoll-gallery` |
| Uploads, owner hash, database, owned by service user | `/var/lib/lidoll-gallery` |
| Environment, mode 0600 | `/etc/lidoll-gallery.env` |
| systemd unit | `/etc/systemd/system/lidoll-gallery.service` |
| Bind address | `10.1.1.23:8787` |
| Public origin | `https://lidoll.dev` |

SELinux stays enabled. The installer runs `restorecon` on its installed paths;
the backend is a Node system service, not an nginx document root. Do not label
the credentials/uploads as public web content or disable SELinux to fix errors.

Check the backend locally:

```sh
sudo systemctl status lidoll-gallery --no-pager
sudo journalctl -u lidoll-gallery -n 50 --no-pager
curl --noproxy '*' --fail http://10.1.1.23:8787/gallery/api/sets
```

A new installation returns `{"sets":[]}`. Direct HTTP is for a backend health
check; perform owner login through the public HTTPS URL because its cookie is
Secure and its origin is deliberately `https://lidoll.dev`.

## 4. Route the gallery through nginx on 10.1.1.20

Copy `/opt/lidoll-gallery/server/gallery/nginx-gallery.conf` from the backend
to the proxy. The installer renders this installed snippet with the selected
port; the repository template uses the default 8787. On a Fedora nginx proxy,
put it in `/etc/nginx/snippets/nginx-gallery.conf`:

```sh
sudo install -d -m 0755 /etc/nginx/snippets
sudo install -m 0644 nginx-gallery.conf /etc/nginx/snippets/nginx-gallery.conf
sudo restorecon -RF /etc/nginx/snippets
sudo setsebool -P httpd_can_network_connect on
```

The SELinux boolean permits nginx's confined web-server domain to connect to
upstream services; it applies to that domain, not only this one backend.
This is the documented [nginx reverse-proxy SELinux setting](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9/html/deploying_web_servers_and_reverse_proxies/setting-up-and-configuring-nginx_deploying-web-servers-and-reverse-proxies).
On a non-SELinux proxy, omit the `restorecon`/`setsebool` commands.

Inside the **existing HTTPS server block for lidoll.dev**, add:

```nginx
include /etc/nginx/snippets/nginx-gallery.conf;
```

This file contains `location` blocks. Do not place it directly into a wildcard
`/etc/nginx/conf.d/*.conf` include at the `http` level. Keep the existing TLS
certificate, HTTP-to-HTTPS redirect, and game routes. Resolve any existing
`/gallery` or `/gallery/` locations before adding the include.

Validate the upstream and reload nginx:

```sh
curl --noproxy '*' --fail http://10.1.1.23:8787/gallery/api/sets
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://lidoll.dev/gallery/api/sets
```

The snippet preserves `/gallery/` and defaults to 1 GiB per upload request
(`1024m`, matching `GALLERY_MAX_UPLOAD_MB=1024`), with streaming and one-hour
proxy send/read timeouts for video. Node allows up to one hour for a complete
request; nginx's client-body inactivity timeout remains 120 seconds. Each file
is sent as a raw request body, so the byte limits match without multipart overhead.
Gallery CSS, API calls and media all
travel through this route. The main site needs only its Gallery link:

```html
<a class="action" href="/gallery/">Gallery</a>
```

That link is already prepared in the game repository's `web/index.html`; deploy
that index separately. No shared stylesheet update is required by this gallery.

## 5. Verify the public site

Open `https://lidoll.dev/gallery/`. Log in and create a test collection, upload
photos and a video, then check playback/seeking, captions and cover selection.
MP4/WebM thumbnails should show a still frame with a play overlay. Select a
video as the collection cover and check its preview in the collection list.
Opening a video should show its poster before playing from the beginning.
Verify a signed-out window sees saved content and does not show editing controls.
Try a larger video through nginx to validate the real proxy limits. Test the
main index link, mobile layout, and logout. Like a collection and a media item
while signed out, refresh to confirm the likes persist, then remove a like.
Open the same collection/media repeatedly: its view count should increase only
once for that browser per UTC day. Check that video playback continues when liked.

The local API/browser checks do not prove the Fedora firewall, SELinux policy,
or existing nginx configuration works; these target-host checks complete that
verification. From another LAN host, 8787 should be refused while it remains
reachable from `10.1.1.20`.

## Updates, backups and password resets

Video previews require the updated `web/gallery/index.html`, `app.js`,
`video-previews.js`, and `style.css` together. The installer and release archive
include them. Existing videos gain previews automatically after the page is
refreshed; no database migration, upload conversion, additional Fedora package,
or nginx setting is required. Each browser extracts a small still frame using
the existing media byte-range endpoint and its own supported codecs. Large
videos may need several range requests before a preview appears; preview
decoders time out after 20 seconds and leave the play overlay as a fallback.

Install a new release using the same installer from a separate extracted folder
or checkout. It restarts the app and preserves `/var/lib/lidoll-gallery` and the
environment file. Back up existing production data first; see [README.md](README.md).
If validation fails after the old service stops, inspect the error/log, fix it,
and rerun the installer. It does not automatically roll back app source.

The views/likes update automatically creates additional SQLite tables at startup;
it does not replace existing sets, uploads, owner credentials or sessions. Old
content starts with zero counts. Backups of the data directory include the new
counts and visitor-signing secret. No new nginx, firewall, or environment setting
is needed. Deploy frontend and backend files from the same release together.

Reset the owner password locally on the gallery box:

```sh
sudo -u lidoll-gallery env GALLERY_DATA_DIR=/var/lib/lidoll-gallery /usr/bin/node-24 /opt/lidoll-gallery/server/gallery/setup.mjs
```

For configuration changes, edit `/etc/lidoll-gallery.env`, then run
`sudo systemctl restart lidoll-gallery`. The installer targets the given IPs and
default paths; update its templates/checks as well if you change that topology.
For port changes, also update the firewall and proxy as described below.

## Changing the gallery port

Examples elsewhere in this guide use the default port 8787. If another app owns
that port, choose a free unprivileged port such as 8788. On the backend, check
it first (no output means no TCP listener currently occupies it):

```sh
sudo ss -ltnp 'sport = :8788'
```

Copy the updated installer to your checkout and run it from that separate
checkout, using the actual LAN firewall zone:

```sh
sudo bash /home/aedith/gallery-site/server/gallery/fedora/install.sh --zone FedoraServer --port 8788
```

This stops/restarts only `lidoll-gallery`, changes its `PORT` setting, adds the
proxy-only firewall rules for 8788, and checks that endpoint. It also handles
a gallery stuck in an automatic restart loop. Omitting `--port` on future
installs reuses the saved `PORT`; a new installation defaults to 8787. The
installer supports ports 1024 through 65535 and rejects unrelated listeners
on the chosen port. No process is killed to free a port.

On the nginx proxy, replace the gallery snippet with the rendered backend copy
from `/opt/lidoll-gallery/server/gallery/nginx-gallery.conf`. For an already
installed default snippet, changing its `proxy_pass` destination to
`http://10.1.1.23:8788` is equivalent. Preserve the URL path (no trailing slash
after the port). Validate and reload nginx, then test:

```sh
sudo nginx -t && sudo systemctl reload nginx
curl --noproxy '*' --fail http://10.1.1.23:8788/gallery/api/sets
curl --fail https://lidoll.dev/gallery/api/sets
```

The public URL stays `https://lidoll.dev/gallery/`; `GALLERY_ORIGIN` stays
`https://lidoll.dev`. Existing firewall rules on the old port are retained
because another application may depend on them; review those separately.

## Changing the per-file upload limit

On the backend, edit `/etc/lidoll-gallery.env` and replace the existing upload
limit with `GALLERY_MAX_UPLOAD_MB=1024`, then run
`sudo systemctl restart lidoll-gallery`. The setting uses MiB: 1024 permits
1,073,741,824 bytes (1 GiB) per file. A batch may contain multiple files of that
size. The environment setting already works in earlier gallery releases.

On the proxy, set `client_max_body_size 1024m;` in the gallery location in
`/etc/nginx/snippets/nginx-gallery.conf`. Run
`sudo nginx -t && sudo systemctl reload nginx`. Refresh the gallery page so
its session reads the new limit. Both servers must allow the larger request.

For deployment through the updated installer, use:

```sh
sudo bash server/gallery/fedora/install.sh --zone FedoraServer --max-upload-mb 1024
```

The saved gallery port is reused. This updates only the upload-limit setting,
prepares the installed nginx snippet with matching port/size settings, and
restarts the gallery. Copy that snippet to the proxy and validate/reload nginx.
The installer accepts integer limits from 1 to 2048 MiB and preserves a saved
limit when the flag is omitted. New installations default to 1024 MiB. Existing
250 MiB configurations therefore need an explicit change. This release also
raises Node's total request deadline from 15 minutes to one hour; deploy the
updated backend and proxy timeouts for large uploads on slow connections.

For a `502`, check the service log, test the backend from the proxy, and inspect
recent SELinux denials with `sudo ausearch -m AVC -ts recent` on the affected
host. For `413`, check nginx's request-body limit and the server upload limit.
For login `403`, check `GALLERY_ORIGIN` and the browser's exact HTTPS hostname.

For `Cannot GET /gallery/`, compare the backend and public responses from the
nginx proxy host (`10.1.1.20`):

```sh
curl --noproxy '*' --max-time 10 -i http://10.1.1.23:8787/gallery/api/sets
curl --max-time 10 -i https://lidoll.dev/gallery/api/sets
```

The backend should return HTTP 200 and a JSON object with a `sets` array. An
HTML `Cannot GET` response with `X-Powered-By: Express` comes from a different
application; this gallery uses Node's built-in HTTP server. If the direct
backend works but the public URL returns that error, check the `/gallery/`
location in the active HTTPS server for `lidoll.dev` on the proxy. It must
forward to `http://10.1.1.23:8787` and preserve the `/gallery/` path, as in the
supplied snippet. Check for an omitted include, a conflicting route, or an
unreloaded configuration. The backend installer does not configure the proxy.
For nginx managed by configuration files, `sudo nginx -T` shows the loaded
configuration on disk; validate with `sudo nginx -t` before reloading. For a
proxy managed through a UI, edit its route through that manager instead of
editing generated files. If the direct backend fails too, check
`sudo systemctl status lidoll-gallery --no-pager` and its journal on the backend
before changing proxy routes.
