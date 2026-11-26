import os
import shutil
import stat
import sys
import tarfile
import zipfile


def validate(entries, app_only=False):
    names = set()
    links = {}
    total = 0
    for name, kind, target, size in entries:
        if not name or name.startswith("/") or len(name) > 1024 or any(ord(c) < 32 or c == "\\" for c in name):
            raise ValueError("Unsafe artifact member name")
        parts = name.split("/")
        if any(part in ("", ".", "..") for part in parts) or name in names:
            raise ValueError("Duplicate or escaping artifact member")
        names.add(name)
        allowed = name == "Ardia.app" or name.startswith("Ardia.app/")
        if not app_only:
            allowed = allowed or name in {"source-commit.txt", "engine.json"}
        if not allowed or kind not in {"file", "directory", "symlink"}:
            raise ValueError("Unexpected artifact member")
        total += size
        if total > 8 * 1024**3 or len(names) > 100000:
            raise ValueError("Artifact exceeds extraction limits")
        if kind == "symlink":
            if not target or target.startswith("/") or any(ord(c) < 32 or c == "\\" for c in target):
                raise ValueError("Unsafe artifact link")
            resolved = os.path.normpath(os.path.join(os.path.dirname(name), target))
            if not resolved.startswith("Ardia.app/"):
                raise ValueError("Artifact link leaves the app")
            links[name] = target
    if "Ardia.app/Contents/Info.plist" not in names:
        raise ValueError("Artifact has no app metadata")
    for name in names:
        parts = name.split("/")
        if any("/".join(parts[:depth]) in links for depth in range(1, len(parts))):
            raise ValueError("Artifact member traverses a link")
    return links


def unpack_tar(archive, destination):
    with tarfile.open(archive, "r:") as source:
        members = source.getmembers()
        entries = [(m.name, "file" if m.isfile() else "directory" if m.isdir() else "symlink" if m.issym() else "other", m.linkname, m.size) for m in members]
        links = validate(entries)
        os.mkdir(destination, 0o700)
        for member in members:
            path = os.path.join(destination, member.name)
            if member.isdir():
                os.makedirs(path, mode=0o755, exist_ok=True)
            elif member.isfile():
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with source.extractfile(member) as inp, open(path, "xb") as out:
                    shutil.copyfileobj(inp, out, 1 << 20)
                os.chmod(path, 0o755 if member.mode & 0o111 else 0o644)
        for name, target in links.items():
            os.makedirs(os.path.dirname(os.path.join(destination, name)), exist_ok=True)
            os.symlink(target, os.path.join(destination, name))
        check_links(destination, links)


def check_links(destination, links):
    app = os.path.realpath(os.path.join(destination, "Ardia.app")) + os.sep
    for name in links:
        if not os.path.realpath(os.path.join(destination, name)).startswith(app):
            raise ValueError("Artifact link chain leaves the app")


def unpack_zip(archive, destination):
    with zipfile.ZipFile(archive) as source:
        members = [m for m in source.infolist() if not m.filename.startswith("__MACOSX/")]
        entries = []
        for member in members:
            mode = member.external_attr >> 16
            link = stat.S_ISLNK(mode)
            if link and member.file_size > 4096:
                raise ValueError("Artifact link is too long")
            kind = "symlink" if link else "directory" if member.is_dir() else "file" if not stat.S_IFMT(mode) or stat.S_ISREG(mode) else "other"
            entries.append((member.filename.rstrip("/"), kind, source.read(member).decode("utf8") if link else "", member.file_size))
        links = validate(entries, app_only=True)
        os.mkdir(destination, 0o700)
        for member, (name, kind, _, _) in zip(members, entries):
            path = os.path.join(destination, name)
            if kind == "directory":
                os.makedirs(path, mode=0o755, exist_ok=True)
            elif kind == "file":
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with source.open(member) as inp, open(path, "xb") as out:
                    shutil.copyfileobj(inp, out, 1 << 20)
                os.chmod(path, 0o755 if (member.external_attr >> 16) & 0o111 else 0o644)
        for name, target in links.items():
            os.makedirs(os.path.dirname(os.path.join(destination, name)), exist_ok=True)
            os.symlink(target, os.path.join(destination, name))
        check_links(destination, links)


def main():
    if len(sys.argv) != 4:
        raise ValueError("Usage: artifact.py pack|unpack|unzip <input> <new output>")
    mode, source, destination = sys.argv[1:]
    if os.path.lexists(destination):
        raise ValueError("Artifact output must not already exist")
    if mode == "pack":
        with tarfile.open(destination, "w", dereference=False) as output:
            for name in ["Ardia.app", "source-commit.txt", "engine.json"]:
                output.add(os.path.join(source, name), arcname=name, recursive=True)
    elif mode == "unpack":
        unpack_tar(source, destination)
    elif mode == "unzip":
        unpack_zip(source, destination)
    else:
        raise ValueError("Unknown artifact operation")


if __name__ == "__main__":
    main()
