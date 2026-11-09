#!/usr/bin/env python3
"""Daily, consistent-enough snapshots of mutable RegionalResearch files.

SQLite is deliberately omitted: backup_sqlite.py copies the live WAL database
using SQLite's online backup API. This archive holds results, logs, templates
and private .env recovery settings. Treat every archive as a secret.
"""
import argparse
import os
import shutil
import tarfile
from datetime import datetime, timezone
from pathlib import Path

MIN_FREE_BYTES = 512 * 1024 * 1024
EXCLUDED_SUFFIXES = (".sqlite", ".sqlite-wal", ".sqlite-shm", ".sqlite-journal")


def included_files(root):
    env = root / ".env"
    if not env.is_file() or env.is_symlink():
        raise FileNotFoundError("Missing regular .env file: " + str(env))
    yield env

    for folder_name in ("data", "exports", "logs"):
        folder = root / folder_name
        if not folder.is_dir() or folder.is_symlink():
            continue
        for base, dirs, files in os.walk(folder, followlinks=False):
            dirs[:] = sorted(d for d in dirs
                             if not (Path(base) / d).is_symlink())
            for filename in sorted(files):
                item = Path(base) / filename
                if (item.is_file() and not item.is_symlink()
                        and not item.name.endswith(EXCLUDED_SUFFIXES)):
                    yield item

    for item in sorted(root.glob("SAT_*")):
        if (item.is_file() and not item.is_symlink()
                and item.suffix.lower() in (".json", ".xlsx", ".xls", ".log")):
            yield item


def validate_tar(path, expected_files):
    names = set()
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            if not member.isfile():
                raise RuntimeError("Unexpected archive entry: " + member.name)
            names.add(member.name)
            stream = archive.extractfile(member)
            if stream is None:
                raise RuntimeError("Cannot read archived file: " + member.name)
            with stream:
                while stream.read(1024 * 1024):
                    pass  # Fully decompress to validate gzip CRC and file contents.
    if names != expected_files:
        raise RuntimeError("Archived file list differs from source snapshot")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--keep", type=int, default=7)
    args = parser.parse_args()

    if args.keep < 1:
        parser.error("--keep must be positive")
    os.umask(0o077)
    root = Path(args.root).resolve(strict=True)
    directory = Path(args.directory).resolve()
    if directory == root or directory.is_relative_to(root):
        raise RuntimeError("Backup destination cannot be inside application directory")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)

    items = list(included_files(root))
    total_bytes = sum(item.stat().st_size for item in items)
    free_bytes = shutil.disk_usage(directory).free
    if free_bytes < max(MIN_FREE_BYTES, total_bytes):
        raise RuntimeError(
            "Not enough free disk for a safe backup: "
            + str(free_bytes) + " free, " + str(total_bytes) + " source bytes"
        )

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    final_path = directory / ("artifacts-" + timestamp + ".tar.gz")
    partial_path = directory / (final_path.name + ".partial")
    names = {item.relative_to(root).as_posix() for item in items}
    try:
        with tarfile.open(partial_path, "w:gz", compresslevel=5) as archive:
            for item in items:
                archive.add(item, arcname=item.relative_to(root).as_posix(),
                            recursive=False)
        validate_tar(partial_path, names)
        os.replace(partial_path, final_path)
    finally:
        partial_path.unlink(missing_ok=True)

    history = sorted(directory.glob("artifacts-*.tar.gz"), reverse=True)
    for obsolete in history[args.keep:]:
        obsolete.unlink()
    print("Artifacts backup OK: " + str(final_path))
    print("Archived " + str(len(items)) + " files; " +
          str(final_path.stat().st_size) + " compressed bytes")
    print("WARNING: archive contains .env secrets; keep it private and offsite-encrypted")


if __name__ == "__main__":
    main()
