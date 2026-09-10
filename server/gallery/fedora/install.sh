#!/usr/bin/env bash
set -euo pipefail

# Installs a checked-out or extracted gallery on the Fedora backend, never on the nginx proxy.
die() { printf 'Gallery installer: %s\n' "$*" >&2; exit 1; }
usage() { # Shows installation options without requiring root or changing the host.
  cat <<'USAGE'
Usage: sudo bash server/gallery/fedora/install.sh [--zone YOUR_LAN_ZONE]

Install or update the gallery backend on Fedora at 10.1.1.23.
The firewall zone is detected from the backend's network interface by default.
Use --zone to require a specific zone; a mismatch stops installation.

Requires running firewalld and an interactive terminal for first owner setup.
Uses existing /usr/bin/node-24 (24.9+); installs nodejs24 only if that binary is absent.
Preserves existing credentials, uploads, database, and /etc/lidoll-gallery.env.
Configure the separate nginx proxy using FEDORA.md after installation.

  -h, --help   Show this help and exit.
USAGE
}
gallery_zone=''
if [[ $# -eq 1 && ( $1 == --help || $1 == -h ) ]]; then usage; exit 0; fi
if [[ $# -ne 0 ]]; then
  [[ $# -eq 2 && $1 == --zone && $2 =~ ^[a-zA-Z0-9_-]+$ ]] || die 'Usage: sudo bash server/gallery/fedora/install.sh [--zone YOUR_LAN_ZONE]'
  gallery_zone=$2
fi
[[ $EUID -eq 0 ]] || die 'Run this installer with sudo.'
[[ -f /etc/fedora-release && ! -e /run/ostree-booted ]] || die 'This installer requires conventional Fedora Server/Workstation with dnf, not an Atomic image.'
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

# Rejects the wrong host or firewall zone before package installation or service interruption.
command -v ip >/dev/null || die 'Install iproute first so the backend address can be checked.'
gallery_interface=$(ip -o -4 addr show | awk '{ split($4, addr, "/"); if (addr[1] == "10.1.1.23") { sub(/@.*/, "", $2); print $2; exit } }')
[[ -n $gallery_interface ]] || die '10.1.1.23 is not assigned to this host. This installer is for the gallery backend.'
command -v firewall-cmd >/dev/null || die 'Install and configure firewalld first, preserving SSH access. See FEDORA.md.'
firewall-cmd --state >/dev/null || die 'Start/configure firewalld first, preserving SSH access. See FEDORA.md.'
gallery_actual_zone=$(firewall-cmd --get-zone-of-interface="$gallery_interface") || die "Cannot determine the firewall zone for $gallery_interface."
if [[ -z $gallery_actual_zone || $gallery_actual_zone == 'no zone' ]]; then
  gallery_actual_zone=$(firewall-cmd --get-default-zone)
fi
if [[ -z $gallery_zone ]]; then gallery_zone=$gallery_actual_zone; fi
[[ $gallery_zone =~ ^[a-zA-Z0-9_-]+$ ]] || die 'Could not detect a valid firewall zone. Check firewalld configuration.'
[[ $gallery_zone == "$gallery_actual_zone" ]] || die "Interface $gallery_interface uses zone $gallery_actual_zone; rerun with --zone $gallery_actual_zone."
firewall-cmd --zone="$gallery_zone" --list-all >/dev/null
firewall-cmd --permanent --zone="$gallery_zone" --list-all >/dev/null # Requires the zone to exist for both immediate and reboot-persistent rules.
if [[ ! -f $gallery_data/admin.json && ! -t 0 ]]; then
  die 'First installation needs an interactive terminal for owner username/password setup. Rerun from a terminal.'
fi
printf 'Installing gallery backend on %s using firewall zone %s.\n' "$gallery_interface" "$gallery_zone"

gallery_node=/usr/bin/node-24
gallery_missing_packages=()
for gallery_package in firewalld policycoreutils shadow-utils util-linux iproute /usr/bin/curl; do
  if ! rpm -q --whatprovides "$gallery_package" >/dev/null 2>&1; then
    gallery_missing_packages+=("$gallery_package")
  fi
done # Requests only missing deployment dependencies instead of upgrading already installed packages.
if [[ ! -x $gallery_node ]]; then gallery_missing_packages+=(nodejs24); fi
if [[ ${#gallery_missing_packages[@]} -gt 0 ]]; then
  dnf --refresh install -y "${gallery_missing_packages[@]}"
fi # Keeps an existing versioned Node runtime and leaves runtime upgrades to the host administrator.
[[ -x $gallery_node ]] || die 'The nodejs24 package must supply /usr/bin/node-24. Check the Fedora Node.js package installation.'
if ! "$gallery_node" --input-type=module -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 9) {
    console.error(`Found Node ${process.versions.node} at ${process.execPath}; this release requires Node 24.9+ within the 24.x stream.`);
    process.exit(1);
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:"); db.exec("SELECT 1"); db.close();
  } catch (error) {
    console.error(`Node SQLite check failed: ${error.message}`);
    process.exit(1);
  }
'; then # Reports recovery steps before installing app files without automatically replacing an existing runtime.
  printf '%s\n' \
    'The selected runtime failed validation; an existing Node installation was not upgraded.' \
    'Check the Fedora release and available packages with:' \
    '  cat /etc/fedora-release' \
    '  sudo dnf --refresh list --available nodejs24' \
    '  dnf repolist' >&2
  die 'A suitable Node runtime is unavailable. Check enabled update repositories, package exclusions/version locks, and Fedora release support. App files and service state have not been changed.'
fi

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
