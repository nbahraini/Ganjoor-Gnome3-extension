#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Helper for the "بیت گنجور" GNOME Shell extension.

It is spawned asynchronously by extension.js (via Gio.Subprocess) so that the
GNOME Shell main loop is never blocked. All output is JSON (one object per
line) on stdout.

Commands:
    beyt   <db_path>              -> one random couplet
    info   <db_path>              -> counts (poets / poems / verses)
    update <db_path> <api_url>    -> download latest ganjoor.s3db and replace db
"""

import sys
import os
import json
import sqlite3
import zipfile
import shutil
import urllib.request

UA = {"User-Agent": "ganjoor-beyt-gnome-extension"}

# A بیت (couplet) = two مصراع (hemistichs): position 0 (right) + position 1 (left)
# with consecutive vorder in the same poem. We first pick a random poem (fast),
# then a random couplet inside it, and join up to the poet name + poem title.
BEYT_QUERY = """
SELECT poet.name, poem.title, v1.text, v2.text
FROM verse v1
JOIN verse v2
     ON v1.poem_id = v2.poem_id
    AND v2.vorder  = v1.vorder + 1
    AND v2.position = 1
JOIN poem ON poem.id     = v1.poem_id
JOIN cat  ON poem.cat_id = cat.id
JOIN poet ON cat.poet_id = poet.id
WHERE v1.position = 0
  AND v1.poem_id = (SELECT id FROM poem ORDER BY RANDOM() LIMIT 1)
ORDER BY RANDOM()
LIMIT 1;
"""


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def open_ro(db):
    # read-only, does not create an empty file if the path is wrong
    return sqlite3.connect("file:%s?mode=ro" % db, uri=True)


def cmd_beyt(db):
    if not os.path.exists(db):
        emit({"ok": False, "error": "db_missing"})
        return
    con = open_ro(db)
    cur = con.cursor()
    row = None
    for _ in range(10):  # some random poems are prose and yield no couplet
        row = cur.execute(BEYT_QUERY).fetchone()
        if row:
            break
    con.close()
    if not row:
        emit({"ok": False, "error": "no_verse"})
        return
    emit({"ok": True, "poet": row[0] or "", "title": row[1] or "",
          "m1": (row[2] or "").strip(), "m2": (row[3] or "").strip()})


def cmd_info(db):
    if not os.path.exists(db):
        emit({"ok": False, "error": "db_missing"})
        return
    con = open_ro(db)
    cur = con.cursor()
    try:
        poets = cur.execute("SELECT COUNT(*) FROM poet").fetchone()[0]
        poems = cur.execute("SELECT COUNT(*) FROM poem").fetchone()[0]
        verses = cur.execute("SELECT COUNT(*) FROM verse").fetchone()[0]
    except Exception as e:
        con.close()
        emit({"ok": False, "error": "bad_db", "detail": str(e)})
        return
    con.close()
    emit({"ok": True, "poets": poets, "poems": poems, "verses": verses})


def cmd_update(db, api_url):
    dstdir = os.path.dirname(os.path.abspath(db))
    os.makedirs(dstdir, exist_ok=True)

    emit({"ok": True, "stage": "lookup"})
    try:
        req = urllib.request.Request(api_url, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
    except Exception as e:
        emit({"ok": False, "error": "api_failed", "detail": str(e)})
        return

    asset = None
    for a in data.get("assets", []):
        n = a.get("name", "").lower()
        if n.startswith("ganjoor-db") and n.endswith(".zip"):
            asset = a
            break
    if not asset:
        emit({"ok": False, "error": "no_asset"})
        return

    url = asset["browser_download_url"]
    tag = data.get("tag_name", "")
    tmpzip = os.path.join(dstdir, ".ganjoor_dl.zip")

    emit({"ok": True, "stage": "download", "size": asset.get("size", 0), "tag": tag})
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            total = int(r.headers.get("Content-Length", 0))
            done = 0
            last_pct = -1
            with open(tmpzip, "wb") as f:
                while True:
                    chunk = r.read(262144)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if total:
                        pct = int(done * 100 / total)
                        if pct != last_pct:
                            last_pct = pct
                            emit({"ok": True, "stage": "download", "progress": pct})
    except Exception as e:
        _rm(tmpzip)
        emit({"ok": False, "error": "download_failed", "detail": str(e)})
        return

    emit({"ok": True, "stage": "extract"})
    try:
        with zipfile.ZipFile(tmpzip) as z:
            member = next((m for m in z.namelist() if m.lower().endswith(".s3db")), None)
            if member is None:
                _rm(tmpzip)
                emit({"ok": False, "error": "no_s3db"})
                return
            tmpdb = os.path.join(dstdir, ".ganjoor_new.s3db")
            with z.open(member) as src, open(tmpdb, "wb") as out:
                shutil.copyfileobj(src, out, 1024 * 1024)
        os.replace(tmpdb, db)   # atomic swap
        _rm(tmpzip)
    except Exception as e:
        _rm(tmpzip)
        _rm(os.path.join(dstdir, ".ganjoor_new.s3db"))
        emit({"ok": False, "error": "extract_failed", "detail": str(e)})
        return

    emit({"ok": True, "stage": "done", "tag": tag})


def _rm(p):
    try:
        os.remove(p)
    except OSError:
        pass


def main():
    if len(sys.argv) < 3:
        emit({"ok": False, "error": "bad_args"})
        return 2
    cmd = sys.argv[1]
    db = os.path.expanduser(sys.argv[2])
    if cmd == "beyt":
        cmd_beyt(db)
    elif cmd == "info":
        cmd_info(db)
    elif cmd == "update":
        api = sys.argv[3] if len(sys.argv) > 3 else \
            "https://api.github.com/repos/ganjoor/desktop/releases/latest"
        cmd_update(db, api)
    else:
        emit({"ok": False, "error": "unknown_cmd"})
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
