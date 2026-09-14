"""Exercise the Fedora updater with local Git remotes and mocked host services."""

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
BASH = shutil.which("bash") if os.name != "nt" else "C:/Program Files/Git/bin/bash.exe"
GIT = shutil.which("git")
NODE = shutil.which("node")
RUNTIME_FILES = (ROOT / "server/gallery/runtime-files.txt").read_text().splitlines()


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="gallery-update-test-")
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.seed = self.root / "seed"
        self.checkout = self.root / "checkout"
        self.remote = self.root / "remote.git"
        self.app = self.root / "opt/lidoll-gallery"
        self.env_file = self.root / "etc/lidoll-gallery.env"
        self.app.mkdir(parents=True)
        (self.app / "old-app.txt").write_text("previous application")
        self.env_file.parent.mkdir()
        self.saved_env = "HOST=10.1.1.23\nPORT=8788\nGALLERY_MAX_UPLOAD_MB=1024\nGALLERY_ORIGIN=https://lidoll.dev\n"
        self.env_file.write_text(self.saved_env)
        self.seed.mkdir()
        for relative in RUNTIME_FILES:
            destination = self.seed / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((ROOT / relative).read_bytes().replace(b"\r\n", b"\n"))
        script = (ROOT / "server/gallery/fedora/update.sh").read_text()
        script = "\n".join(line for line in script.splitlines() if not line.startswith("  [[ $EUID") and not line.startswith("  [[ -f /etc/fedora-release"))
        script = script.replace("/etc/lidoll-gallery.env", '"$GALLERY_TEST_ROOT/etc/lidoll-gallery.env"')
        script = script.replace("gallery_app=/opt/lidoll-gallery", 'gallery_app="$GALLERY_TEST_ROOT/opt/lidoll-gallery"')
        script = script.replace("gallery_node=/usr/bin/node-24", 'gallery_node="$GALLERY_TEST_NODE"')
        script = script.replace("9>/run/lock/lidoll-gallery-deploy.lock", '9>"$GALLERY_TEST_ROOT/deploy.lock"')
        script = script.replace("mktemp -d /opt/.lidoll-gallery-update.XXXXXX", 'mktemp -d "$GALLERY_TEST_ROOT/opt/.lidoll-gallery-update.XXXXXX"')
        script = script.replace("/usr/lib/node_modules_24/npm/bin/npm-cli.js", '"$GALLERY_TEST_NPM"')
        updater = self.seed / "server/gallery/fedora/update.sh"
        updater.parent.mkdir(parents=True, exist_ok=True)
        updater.write_text(script + "\n", newline="\n")  # Redirects fixed host paths and privilege checks only in the disposable fixture.
        (self.seed / ".gitignore").write_text("private.json\n")
        self.git(self.root, "init", "--bare", "--initial-branch=main", str(self.remote))
        self.git(self.seed, "init", "-b", "main")
        self.git(self.seed, "add", ".")
        self.git(self.seed, "commit", "-m", "Initial fixture")
        self.git(self.seed, "remote", "add", "origin", str(self.remote))
        self.git(self.seed, "push", "-u", "origin", "main")
        self.git(self.root, "clone", str(self.remote), str(self.checkout))
        (self.checkout / "private.json").write_text("must never be deployed")
        mock_bin = self.root / "bin"
        mock_bin.mkdir()
        mocks = {
            "stat": "printf 'root\\n'",
            "id": "exit 0",
            "flock": "exit 0",
            "restorecon": "exit 0",
            "install": 'mkdir -p "${@: -1}"',
            "runuser": 'shift 3; exec "$@"',
            "journalctl": "echo 'Mock gallery journal'",
            "sleep": "exit 0",
            "curl": 'if [[ ${GALLERY_TEST_BAD_HEALTH:-0} == 1 ]]; then printf "{}"; else printf \'{"sets":[]}\'; fi',
            "systemctl": '''printf '%s\\n' "$*" >> "$GALLERY_TEST_ROOT/service.log"
case $1 in
  show) echo loaded ;;
  start) if [[ ${GALLERY_TEST_FAIL_START:-0} == 1 && -f $GALLERY_TEST_ROOT/opt/lidoll-gallery/.deployment-revision ]]; then exit 1; fi ;;
esac''',
            "git": '''if [[ ${*: -2} == 'rev-parse --show-toplevel' && $OSTYPE == msys ]]; then
  "$GALLERY_REAL_GIT" "$@" | cygpath -u -f -
else exec "$GALLERY_REAL_GIT" "$@"; fi''',
        }
        for name, body in mocks.items():
            executable = mock_bin / name
            executable.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body + "\n", newline="\n")
            executable.chmod(0o755)
        self.env = os.environ.copy()
        self.env.update(GALLERY_TEST_ROOT=self.root.as_posix(), GALLERY_TEST_NODE=Path(NODE).as_posix(), GALLERY_REAL_GIT=Path(GIT).as_posix())
        npm_stub = self.root / "npm-stub.cjs"
        npm_stub.write_text("""const fs=require('node:fs'),path=require('node:path');
if(!process.argv.includes('--omit=dev')||!process.argv.includes('--ignore-scripts'))process.exit(1);
for(const name of ['openid-client','oauth4webapi','jose','sharp','@img','@emnapi','detect-libc','semver','tslib']) {
 const source=path.join(process.env.GALLERY_TEST_MODULES,name);
 if(fs.existsSync(source))fs.cpSync(source,path.join(process.cwd(),'node_modules',name),{recursive:true});
}
""")  # Mocks dependency delivery from the verified local install; the staged API tests still run for real.
        self.env.update(GALLERY_TEST_NPM=npm_stub.as_posix(), GALLERY_TEST_MODULES=(ROOT / "node_modules").as_posix())
        self.mock_bin = mock_bin

    def git(self, cwd, *args):
        return subprocess.run([GIT, "-c", "user.name=Updater Test", "-c", "user.email=updater@example.invalid", "-c", "core.autocrlf=false", "-C", str(cwd), *args], check=True, text=True, capture_output=True).stdout.strip()

    def publish(self):
        (self.seed / "web/gallery/new-asset.js").write_text("// New tracked asset\n")
        with (self.seed / "server/gallery/runtime-files.txt").open("a") as manifest:
            manifest.write("web/gallery/new-asset.js\n")
        with (self.seed / "server/gallery/fedora/update.sh").open("a") as updater:
            updater.write("# Upstream updater changed while the old workflow was running.\n")
        self.git(self.seed, "add", ".")
        self.git(self.seed, "commit", "-m", "Updated fixture")
        self.git(self.seed, "push")

    def update(self, success=True):
        self.env["GALLERY_TEST_BIN"] = self.mock_bin.as_posix()
        command = 'if [[ $OSTYPE == msys ]]; then GALLERY_TEST_BIN=$(cygpath -u "$GALLERY_TEST_BIN"); export GALLERY_TEST_ROOT=$(cygpath -u "$GALLERY_TEST_ROOT"); fi; export PATH="$GALLERY_TEST_BIN:$PATH"; bash "$GALLERY_TEST_ROOT/checkout/server/gallery/fedora/update.sh"'
        result = subprocess.run([BASH, "-c", command], env=self.env, capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertEqual(self.env_file.read_text(), self.saved_env)
        return result

    def test_pull_stage_activate_and_preserve_settings(self):
        self.publish()
        self.update()
        self.assertTrue((self.app / "web/gallery/new-asset.js").is_file())
        self.assertFalse((self.app / "private.json").exists())
        self.assertEqual((self.app / ".deployment-revision").read_text().strip(), self.git(self.seed, "rev-parse", "HEAD"))
        snippet = (self.app / "server/gallery/nginx-gallery.conf").read_text()
        self.assertIn("http://10.1.1.23:8788;", snippet)
        self.assertIn("client_max_body_size 1024m;", snippet)
        self.assertEqual(len(list((self.root / "opt").glob(".lidoll-gallery-update.*/previous/old-app.txt"))), 1)

    def test_dirty_checkout_leaves_running_app_alone(self):
        self.publish()
        (self.checkout / "README.md").write_text("local edits")
        self.assertIn("local changes", self.update(False).stderr)
        self.assertNotIn("stop lidoll-gallery", (self.root / "service.log").read_text())
        self.assertTrue((self.app / "old-app.txt").exists())

    def test_diverged_history_is_not_merged(self):
        self.publish()
        (self.checkout / "local.txt").write_text("local commit")
        self.git(self.checkout, "add", ".")
        self.git(self.checkout, "commit", "-m", "Diverged")
        self.assertIn("fast-forward", self.update(False).stderr.lower())
        self.assertTrue((self.app / "old-app.txt").exists())
        self.assertNotIn("stop lidoll-gallery", (self.root / "service.log").read_text())

    def test_failed_api_tests_do_not_stop_running_app(self):
        (self.seed / "server/gallery/gallery.test.mjs").write_text('throw new Error("Expected fixture failure");\n')
        self.publish()
        result = self.update(False)
        self.assertIn("Expected fixture failure", result.stdout + result.stderr)
        self.assertTrue((self.app / "old-app.txt").exists())
        self.assertNotIn("stop lidoll-gallery", (self.root / "service.log").read_text())

    def test_failed_start_restores_previous_app(self):
        self.publish()
        self.env["GALLERY_TEST_FAIL_START"] = "1"
        self.update(False)
        self.assertTrue((self.app / "old-app.txt").exists())
        self.assertEqual(len(list((self.root / "opt").glob(".lidoll-gallery-update.*/failed/.deployment-revision"))), 1)
        self.assertEqual((self.root / "service.log").read_text().splitlines()[-1], "start lidoll-gallery")

    def test_wrong_health_response_restores_previous_app(self):
        self.publish()
        self.env["GALLERY_TEST_BAD_HEALTH"] = "1"
        self.update(False)
        self.assertTrue((self.app / "old-app.txt").exists())
        self.assertEqual(len(list((self.root / "opt").glob(".lidoll-gallery-update.*/failed/.deployment-revision"))), 1)
        self.assertEqual((self.root / "service.log").read_text().splitlines()[-1], "start lidoll-gallery")


if __name__ == "__main__":
    unittest.main(verbosity=2)
