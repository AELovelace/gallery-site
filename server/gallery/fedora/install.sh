#!/usr/bin/env bash
set -euo pipefail

# Installs a checked-out or extracted gallery on the Fedora backend, never on the nginx proxy.
die() { printf 'Gallery installer: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die 'Run this installer with sudo.'
[[ -f /etc/fedora-release && ! -e /run/ostree-booted ]] || die 'This installer requires conventional Fedora Server/Workstation with dnf, not an Atomic image.'
[[ $# -eq 2 && $1 == --zone && $2 =~ ^[a-zA-Z0-9_-]+$ ]] || die 'Usage: sudo bash server/gallery/fedora/install.sh --zone YOUR_LAN_ZONE'
gallery_zone=$2
gallery_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)
gallery_app=/opt/lidoll-gallery
gallery_data=/var/lib/lidoll-gallery
[[ $gallery_source != "$gallery_app" ]] || die 'Run the installer from a separate checkout/extracted release, not /opt/lidoll-gallery.'
[[ ! -L $gallery_app && ! -L $gallery_data ]] || die 'Application and data directories must not be symbolic links.'

# Uses an explicit file list so uploads, credentials, Git history, and the game are never installed as website files.
gallery_files=(
  README.md FEDORA.md package.json
  server/gallery/server.mjs server/gallery/setup.mjs server/gallery/gallery.test.mjs
  server/gallery/gallery.env.example server/gallery/lidoll-gallery.service
  server/gallery/nginx-gallery.conf
  web/gallery/index.html web/gallery/app.js web/gallery/preferences.js
  web/gallery/style.css web/gallery/theme.css
)
for gallery_file in "${gallery_files[@]}"; do
  [[ -f $gallery_source/$gallery_file && ! -L $gallery_source/$gallery_file ]] || die "Missing or symlinked release file: $gallery_file"
done

dnf install -y nodejs24 firewalld policycoreutils shadow-utils util-linux iproute /usr/bin/curl
gallery_node=/usr/bin/node-24
[[ -x $gallery_node ]] || die 'The nodejs24 package must supply /usr/bin/node-24. Check the Fedora Node.js package installation.'
"$gallery_node" --input-type=module -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 14) throw new Error("Node 24.14+ is required. Update the Fedora nodejs24 packages and rerun.");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:"); db.exec("SELECT 1"); db.close();
' # Fails before installing app files if Fedora's selected runtime is too old or lacks SQLite.

firewall-cmd --state >/dev/null || die 'Start/configure firewalld first, then rerun with the zone of the 10.1.1.23 interface. See FEDORA.md.'
firewall-cmd --zone="$gallery_zone" --list-all >/dev/null
gallery_interface=$(ip -o -4 addr show | awk '{ split($4, addr, "/"); if (addr[1] == "10.1.1.23") { sub(/@.*/, "", $2); print $2; exit } }')
[[ -n $gallery_interface ]] || die '10.1.1.23 is not assigned to this host. This installer is for the gallery backend.'
gallery_actual_zone=$(firewall-cmd --get-zone-of-interface="$gallery_interface" || true)
if [[ -z $gallery_actual_zone || $gallery_actual_zone == 'no zone' ]]; then
  gallery_actual_zone=$(firewall-cmd --get-default-zone)
fi
[[ $gallery_zone == "$gallery_actual_zone" ]] || die "Interface $gallery_interface uses zone $gallery_actual_zone; rerun with --zone $gallery_actual_zone."

if ! getent group lidoll-gallery >/dev/null; then groupadd --system lidoll-gallery; fi
if ! id lidoll-gallery >/dev/null 2>&1; then
  useradd --system --gid lidoll-gallery --home-dir "$gallery_data" --no-create-home --shell /usr/sbin/nologin lidoll-gallery
fi
[[ $(id -u lidoll-gallery) -ne 0 && $(id -gn lidoll-gallery) == lidoll-gallery ]] || die 'The lidoll-gallery account must be non-root with primary group lidoll-gallery.'
install -d -o lidoll-gallery -g lidoll-gallery -m 0700 "$gallery_data"
install -d -o root -g root -m 0755 "$gallery_app"

# Stops the old process only when installation preflight has passed; persistent content is never replaced.
if systemctl is-active --quiet lidoll-gallery; then systemctl stop lidoll-gallery; fi
for gallery_file in "${gallery_files[@]}"; do
  install -D -o root -g root -m 0644 "$gallery_source/$gallery_file" "$gallery_app/$gallery_file"
done
if [[ ! -e /etc/lidoll-gallery.env ]]; then
  install -o root -g root -m 0600 "$gallery_source/server/gallery/gallery.env.example" /etc/lidoll-gallery.env
fi
install -o root -g root -m 0644 "$gallery_source/server/gallery/lidoll-gallery.service" /etc/systemd/system/lidoll-gallery.service
restorecon -RF "$gallery_app" "$gallery_data" /etc/lidoll-gallery.env /etc/systemd/system/lidoll-gallery.service # Applies Fedora's normal SELinux labels without disabling enforcement.

runuser -u lidoll-gallery -- "$gallery_node" --test "$gallery_app/server/gallery/gallery.test.mjs"
if [[ ! -f $gallery_data/admin.json ]]; then
  [[ -t 0 ]] || die 'First installation needs an interactive terminal for owner username/password setup. Rerun from a terminal.'
  runuser -u lidoll-gallery -- env GALLERY_DATA_DIR="$gallery_data" "$gallery_node" "$gallery_app/server/gallery/setup.mjs"
fi

# Negative priorities run before normal open-port/service rules; only this backend address and port are affected.
gallery_allow='rule family="ipv4" priority="-100" source address="10.1.1.20/32" destination address="10.1.1.23/32" port port="8787" protocol="tcp" accept'
gallery_reject='rule family="ipv4" priority="-90" source not address="10.1.1.20/32" destination address="10.1.1.23/32" port port="8787" protocol="tcp" reject'
for gallery_rule in "$gallery_allow" "$gallery_reject"; do
  firewall-cmd --permanent --zone="$gallery_zone" --add-rich-rule="$gallery_rule"
  firewall-cmd --zone="$gallery_zone" --add-rich-rule="$gallery_rule"
done # Updates runtime and permanent rules without reloading unrelated firewall configuration.

systemctl daemon-reload
systemctl enable firewalld # Retains the gallery's permanent LAN restrictions after a backend reboot.
systemctl enable --now lidoll-gallery
gallery_ready=false
for gallery_attempt in {1..15}; do
  if curl --noproxy '*' --fail --silent --max-time 2 http://10.1.1.23:8787/gallery/api/sets >/dev/null; then
    gallery_ready=true
    break
  fi
  sleep 1
done
if [[ $gallery_ready != true ]]; then
  journalctl -u lidoll-gallery -n 30 --no-pager
  die 'The service did not become healthy. See the log above; existing uploads have not been replaced.'
fi
printf '\nGallery is running on 10.1.1.23:8787. Complete the nginx steps on 10.1.1.20 in FEDORA.md.\n'
