#!/usr/bin/env python3
"""Consistent online SQLite backup under WAL without stopping research."""
import argparse
import os
import sqlite3
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
        with sqlite3.connect("file:" + str(source) + "?mode=ro", uri=True) as db:
            with sqlite3.connect(str(temporary)) as dst:
                db.backup(dst, pages=128, sleep=0.1)
                check = dst.execute("PRAGMA integrity_check").fetchone()[0]
                if check != "ok":
                    raise RuntimeError("Integrity check failed: " + str(check))
        os.replace(temporary, filename)
    finally:
        if temporary.exists():
            temporary.unlink()
    history = sorted(directory.glob("checkpoints-*.sqlite"), reverse=True)
    for old in history[max(1, args.keep):]:
        old.unlink()
    print("SQLite backup:", filename)

if __name__ == "__main__":
    main()
