#!/usr/bin/env bash
set -euo pipefail

gallery_update_die() { printf 'Gallery updater: %s\n' "$*" >&2; exit 1; }

gallery_update_git() {
  if [[ $gallery_checkout_user == root ]]; then
    git -C "$gallery_source" "$@"
  else
    runuser -u "$gallery_checkout_user" -- git -C "$gallery_source" "$@"
  fi # Pulls with the checkout owner's credentials and ownership, including when launched with sudo.
}

gallery_update_setting() {
  local gallery_value
  gallery_value=$(awk -v key="$1" -v fallback="$2" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", ""); sub(/[[:space:]]*$/, ""); value=$0; found=1
    }
    END { if (found) print value; else print fallback }
  ' /etc/lidoll-gallery.env)
  gallery_value=${gallery_value#\"}; gallery_value=${gallery_value%\"}
  gallery_value=${gallery_value#\'}; gallery_value=${gallery_value%\'}
  printf '%s' "$gallery_value" # Reads the three health/proxy settings without executing the environment file as root.
}

gallery_update_exit() {
  local gallery_status=$?
  trap - EXIT
  if (( gallery_status != 0 && gallery_stopped == 1 )); then
    printf 'Update failed; recovering the previous application.\n' >&2
    systemctl stop lidoll-gallery || { printf 'Could not stop the failed service; inspect %s before recovery.\n' "$gallery_work" >&2; exit "$gallery_status"; }
    if [[ -d $gallery_work/previous ]]; then
      if [[ -d $gallery_app ]]; then
        mv -- "$gallery_app" "$gallery_work/failed" || { printf 'Could not preserve failed app; inspect %s.\n' "$gallery_work" >&2; exit "$gallery_status"; }
      fi
      mv -- "$gallery_work/previous" "$gallery_app" || { printf 'Could not restore previous app; inspect %s.\n' "$gallery_work" >&2; exit "$gallery_status"; }
      restorecon -RF "$gallery_app" || true
    fi
    systemctl start lidoll-gallery || printf 'Previous app could not start; inspect journalctl -u lidoll-gallery.\n' >&2
    printf 'Recovery files: %s. Database changes made by a failed new startup are not rolled back.\n' "$gallery_work" >&2
  fi # Restores app source after activation failures; credentials, uploads, SQLite, and the installed unit are never replaced.
  exit "$gallery_status"
}

gallery_update_main() {
  if [[ $# -eq 1 && ( $1 == --help || $1 == -h ) ]]; then
    cat <<'USAGE'
Usage: sudo bash server/gallery/fedora/update.sh

Update an existing gallery from a clean Git checkout with a tracking branch.
Pulls with --ff-only as the checkout owner, stages tracked production files,
runs API tests as lidoll-gallery, swaps app source, and restarts the service.
Preserves Node, installed unit/drop-ins, environment, data, and firewall rules.
Retains the previous app under /opt and restores it if activation fails.
The separate nginx proxy is not changed. No packages are installed.
USAGE
    return
  fi
  [[ $# -eq 0 ]] || gallery_update_die 'Use --help for usage; configuration changes belong in install.sh or /etc/lidoll-gallery.env.'
  [[ $EUID -eq 0 ]] || gallery_update_die 'Run with sudo from your Git checkout.'
  [[ -f /etc/fedora-release && ! -e /run/ostree-booted ]] || gallery_update_die 'This updater requires conventional Fedora.'
  for gallery_command in git runuser systemctl install tar flock curl restorecon; do
    command -v "$gallery_command" >/dev/null || gallery_update_die "Missing prerequisite: $gallery_command. Use install.sh for initial setup."
  done
  gallery_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)
  gallery_app=/opt/lidoll-gallery
  gallery_node=/usr/bin/node-24
  [[ -d $gallery_app && ! -L $gallery_app && -f /etc/lidoll-gallery.env && ! -L /etc/lidoll-gallery.env ]] || gallery_update_die 'An existing gallery installation and regular environment file are required.'
  [[ -x $gallery_node && $(systemctl show --property=LoadState --value lidoll-gallery) == loaded ]] || gallery_update_die 'The existing Node runtime and installed gallery service are required.'
  [[ $gallery_source != "$gallery_app" ]] || gallery_update_die 'Run from your separate Git checkout, not /opt/lidoll-gallery.'
  exec 9>/run/lock/lidoll-gallery-deploy.lock
  flock -n 9 || gallery_update_die 'Another gallery deployment is running.'
  gallery_checkout_user=$(stat -c '%U' "$gallery_source")
  [[ $gallery_checkout_user != UNKNOWN ]] || gallery_update_die 'Cannot identify the Git checkout owner.'
  id lidoll-gallery >/dev/null 2>&1 || gallery_update_die 'The gallery service account is missing; use install.sh first.'
  [[ $(gallery_update_git rev-parse --show-toplevel) == "$gallery_source" ]] || gallery_update_die 'Run this script from the gallery Git repository, not an extracted tarball.'
  gallery_update_git symbolic-ref --quiet HEAD >/dev/null || gallery_update_die 'Checkout is detached; switch to a branch with an upstream first.'
  gallery_update_git rev-parse --verify '@{upstream}' >/dev/null || gallery_update_die 'The current branch needs a configured upstream.'
  [[ -z $(gallery_update_git status --porcelain --untracked-files=normal) ]] || gallery_update_die 'Checkout has local changes or untracked files. Commit, stash, or move them before updating; nothing was discarded.'

  gallery_host=$(gallery_update_setting HOST 10.1.1.23)
  gallery_port=$(gallery_update_setting PORT 8787)
  gallery_upload_mb=$(gallery_update_setting GALLERY_MAX_UPLOAD_MB 1024)
  [[ $gallery_host =~ ^[a-zA-Z0-9.:-]+$ ]] || gallery_update_die 'Unsupported HOST value in the environment file.'
  [[ $gallery_port =~ ^[1-9][0-9]{3,4}$ ]] && (( gallery_port >= 1024 && gallery_port <= 65535 )) || gallery_update_die 'PORT must be between 1024 and 65535.'
  [[ $gallery_upload_mb =~ ^[1-9][0-9]{0,3}$ ]] && (( gallery_upload_mb <= 2048 )) || gallery_update_die 'GALLERY_MAX_UPLOAD_MB must be an integer from 1 to 2048.'

  gallery_update_git pull --ff-only --no-rebase
  [[ -z $(gallery_update_git status --porcelain --untracked-files=normal) ]] || gallery_update_die 'Checkout changed during pull; app was not updated.'
  gallery_revision=$(gallery_update_git rev-parse HEAD)
  gallery_manifest=$(gallery_update_git show "$gallery_revision:server/gallery/runtime-files.txt")
  mapfile -t gallery_files <<< "$gallery_manifest"
  for gallery_file in "${gallery_files[@]}"; do
    [[ $gallery_file =~ ^[a-zA-Z0-9_./-]+$ && $gallery_file != /* && $gallery_file != *..* ]] || gallery_update_die "Invalid runtime path: $gallery_file"
    gallery_mode=$(gallery_update_git ls-tree "$gallery_revision" -- "$gallery_file")
    [[ $gallery_mode == '100644 blob '* || $gallery_mode == '100755 blob '* ]] || gallery_update_die "Missing or non-regular tracked runtime file: $gallery_file"
  done # A committed manifest supplies an explicit production allowlist, including new assets added by the pulled release.

  gallery_work=$(mktemp -d /opt/.lidoll-gallery-update.XXXXXX)
  gallery_stopped=0
  trap gallery_update_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  chmod 0755 "$gallery_work"
  install -d -o root -g root -m 0755 "$gallery_work/candidate"
  gallery_update_git archive --format=tar "$gallery_revision" -- "${gallery_files[@]}" | tar --extract --no-same-owner --no-same-permissions --file=- --directory="$gallery_work/candidate"
  for gallery_file in "${gallery_files[@]}"; do
    [[ -f $gallery_work/candidate/$gallery_file && ! -L $gallery_work/candidate/$gallery_file ]] || gallery_update_die "Runtime file missing from staged archive: $gallery_file"
  done # Detects archive export exclusions before stopping the installed application.
  find "$gallery_work/candidate" -type d -exec chmod 0755 {} +
  find "$gallery_work/candidate" -type f -exec chmod 0644 {} +
  sed -i "s|http://10.1.1.23:8787|http://$gallery_host:$gallery_port|g" "$gallery_work/candidate/server/gallery/nginx-gallery.conf"
  sed -i -E "s|client_max_body_size [0-9]+m;|client_max_body_size ${gallery_upload_mb}m;|" "$gallery_work/candidate/server/gallery/nginx-gallery.conf"
  printf '%s\n' "$gallery_revision" > "$gallery_work/candidate/.deployment-revision"
  restorecon -RF "$gallery_work"
  cd -- "$gallery_work/candidate"
  runuser -u lidoll-gallery -- "$gallery_node" --test server/gallery/gallery.test.mjs # Tests staged code from an accessible directory while the existing service keeps running.

  systemctl stop lidoll-gallery
  gallery_stopped=1
  mv -- "$gallery_app" "$gallery_work/previous"
  mv -- "$gallery_work/candidate" "$gallery_app"
  cd -- "$gallery_app"
  restorecon -RF "$gallery_app"
  systemctl start lidoll-gallery
  gallery_health_host=$gallery_host
  if [[ $gallery_health_host == 0.0.0.0 ]]; then gallery_health_host=127.0.0.1; fi
  if [[ $gallery_health_host == :: ]]; then gallery_health_host=::1; fi
  if [[ $gallery_health_host == *:* ]]; then gallery_health_host="[$gallery_health_host]"; fi
  for gallery_attempt in {1..15}; do
    if systemctl is-active --quiet lidoll-gallery && curl --noproxy '*' --fail --silent --max-time 2 "http://$gallery_health_host:$gallery_port/gallery/api/sets" | "$gallery_node" --input-type=module -e '
      let body = ""; for await (const chunk of process.stdin) body += chunk;
      try { if (!Array.isArray(JSON.parse(body).sets)) process.exit(1); } catch { process.exit(1); }
    '; then
      gallery_stopped=0
      printf '\nGallery updated to %s. Previous app: %s/previous\n' "$gallery_revision" "$gallery_work"
      printf 'Saved port %s and upload limit %s MiB retained. Public URL: https://lidoll.dev/gallery/\n' "$gallery_port" "$gallery_upload_mb"
      return
    fi
    sleep 1
  done
  journalctl -u lidoll-gallery -n 30 --no-pager || true
  gallery_update_die 'Updated service did not pass its health check.'
} # Parses the entire workflow before git pull can replace this script on disk.

gallery_update_main "$@"
