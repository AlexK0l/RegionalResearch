#!/usr/bin/env python3
"""Consistent online SQLite backup under WAL without stopping research."""
import argparse
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--keep", type=int, default=14)
    args = parser.parse_args()
    source = Path(args.source).resolve()
    if not source.is_file():
        print("No checkpoint database yet. Nothing to back up.")
        return
    directory = Path(args.directory).resolve()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.umask(0o077)
    filename = directory / ("checkpoints-" +
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".sqlite")
    temporary = directory / (filename.name + ".partial")
    if temporary.exists():
        raise RuntimeError("Existing partial backup: " + str(temporary))
    try:
        # sqlite3.Connection's context manager commits/rolls back, but does not
        # close the connection. Close both before publishing the backup.
        with closing(sqlite3.connect("file:" + str(source) + "?mode=ro",
                                     uri=True, timeout=30)) as db:
            with closing(sqlite3.connect(str(temporary), timeout=30)) as dst:
                db.backup(dst, pages=128, sleep=0.1)

                # Backing up a WAL database can leave the destination in WAL
                # mode. Force any copied WAL content into the standalone file,
                # so restoring only checkpoints-*.sqlite is always sufficient.
                journal_mode = dst.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
                if journal_mode.lower() != "delete":
                    raise RuntimeError("Could not finalize backup journal mode")
                check = dst.execute("PRAGMA integrity_check").fetchone()[0]
                if check != "ok":
                    raise RuntimeError("Integrity check failed: " + str(check))

        # Verify the saved file from a *new* connection after both are closed.
        with closing(sqlite3.connect("file:" + str(temporary) + "?mode=ro",
                                     uri=True, timeout=30)) as verify:
            check = verify.execute("PRAGMA integrity_check").fetchone()[0]
            if check != "ok":
                raise RuntimeError("Backup read-back integrity check failed: " + str(check))

        os.replace(temporary, filename)
    finally:
        for suffix in ("", "-wal", "-shm", "-journal"):
            sidecar = Path(str(temporary) + suffix)
            if sidecar.exists():
                sidecar.unlink()
    history = sorted(directory.glob("checkpoints-*.sqlite"), reverse=True)
    for old in history[max(1, args.keep):]:
        old.unlink()
    print("SQLite backup:", filename)

if __name__ == "__main__":
    main()
