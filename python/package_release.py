"""Build the Fedora release from an explicit list, excluding local credentials and uploads."""

from hashlib import sha256
from io import BytesIO
from pathlib import Path
import tarfile


ROOT = Path(__file__).resolve().parents[1]
RELEASE_FILES = (
    *(ROOT / "server/gallery/runtime-files.txt").read_text(encoding="utf-8").splitlines(),
    "server/gallery/fedora/install.sh", "server/gallery/fedora/update.sh",
)


def build_release() -> Path:
    """Package only production source/configuration and the backend verification suite."""
    destination = ROOT / "dist" / "lidoll-gallery-fedora.tar.gz"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(destination, "w:gz") as archive:
        for relative in RELEASE_FILES:
            if not relative or Path(relative).is_absolute() or ".." in relative or "\\" in relative:
                raise ValueError(f"Invalid release path: {relative}")
            source = ROOT / relative
            if source.is_symlink() or not source.is_file():
                raise ValueError(f"Missing or symlinked release source: {relative}")
            payload = source.read_bytes().replace(b"\r\n", b"\n")  # Produces Linux-ready text even when built from a Windows checkout.
            entry = tarfile.TarInfo(f"lidoll-gallery/{relative}")
            entry.size = len(payload)
            entry.mode = 0o755 if relative.endswith(".sh") else 0o644
            entry.mtime = 0  # Omits local modification timestamps and ownership from the archive.
            archive.addfile(entry, BytesIO(payload))
    checksum = sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix(destination.suffix + ".sha256").write_text(
        f"{checksum}  {destination.name}\n", encoding="utf-8"
    )  # Lets the Fedora host verify that its copied archive matches the prepared release.
    print(f"Built {destination} ({destination.stat().st_size:,} bytes)")
    print(f"SHA256 {checksum}")
    return destination


if __name__ == "__main__":
    build_release()
