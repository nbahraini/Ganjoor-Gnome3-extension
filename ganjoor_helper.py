#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Helper for the "بیت گنجور" GNOME Shell extension.

It is spawned asynchronously by extension.js (via Gio.Subprocess) so that the
GNOME Shell main loop is never blocked. All output is JSON (one object per
line) on stdout.

Commands:
    beyt   <db_path> [poet_ids]   -> one random couplet
                                     (poet_ids: optional comma-separated list of
                                      poet ids to restrict the pick to)
    poets  <db_path>              -> list of poets that have couplets
                                     (one JSON object per line: id / name / poems)
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
#
# The inner sub-query that chooses the random poem is built at run time so that,
# when the user has restricted the selection to certain poets, only poems that
# belong to those poets are considered. {POEM_PICK} is replaced accordingly.
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
  AND v1.poem_id = ({POEM_PICK})
ORDER BY RANDOM()
LIMIT 1;
"""

# Random poem across the whole database (no poet restriction).
POEM_PICK_ANY = "SELECT id FROM poem ORDER BY RANDOM() LIMIT 1"

# Random poem restricted to a set of poet ids ({IDS} -> ?,?,… placeholders).
POEM_PICK_BY_POET = """
SELECT poem.id FROM poem
JOIN cat ON poem.cat_id = cat.id
WHERE cat.poet_id IN ({IDS})
ORDER BY RANDOM() LIMIT 1
"""

# All poets that actually own at least one poem (so the settings list never
# shows empty categories). Ordered by name for a stable, readable list.
POETS_QUERY = """
SELECT poet.id, poet.name, COUNT(DISTINCT poem.id) AS n
FROM poet
JOIN cat  ON cat.poet_id = poet.id
JOIN poem ON poem.cat_id = cat.id
GROUP BY poet.id, poet.name
HAVING n > 0
ORDER BY poet.name COLLATE NOCASE;
"""


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def open_ro(db):
    # read-only, does not create an empty file if the path is wrong
    return sqlite3.connect("file:%s?mode=ro" % db, uri=True)


def _parse_poet_ids(raw):
    """Turn a comma-separated string into a list of positive ints."""
    ids = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            n = int(part)
        except ValueError:
            continue
        if n > 0:
            ids.append(n)
    return ids


def cmd_beyt(db, poet_ids=None):
    if not os.path.exists(db):
        emit({"ok": False, "error": "db_missing"})
        return
    con = open_ro(db)
    cur = con.cursor()

    if poet_ids:
        placeholders = ",".join("?" * len(poet_ids))
        pick = POEM_PICK_BY_POET.format(IDS=placeholders)
        query = BEYT_QUERY.format(POEM_PICK=pick)
        params = poet_ids
    else:
        query = BEYT_QUERY.format(POEM_PICK=POEM_PICK_ANY)
        params = []

    row = None
    for _ in range(10):  # some random poems are prose and yield no couplet
        row = cur.execute(query, params).fetchone()
        if row:
            break
    con.close()
    if not row:
        # With a poet filter this most likely means the chosen poets have no
        # couplets (e.g. prose-only); distinguish it so the UI can explain.
        emit({"ok": False,
              "error": "no_verse_for_poets" if poet_ids else "no_verse"})
        return
    emit({"ok": True, "poet": row[0] or "", "title": row[1] or "",
          "m1": (row[2] or "").strip(), "m2": (row[3] or "").strip()})


def cmd_poets(db):
    if not os.path.exists(db):
        emit({"ok": False, "error": "db_missing"})
        return
    con = open_ro(db)
    cur = con.cursor()
    try:
        rows = cur.execute(POETS_QUERY).fetchall()
    except Exception as e:
        con.close()
        emit({"ok": False, "error": "bad_db", "detail": str(e)})
        return
    con.close()
    # Emit a header first, then one line per poet. The extension reads all
    # lines, so a single object with a list keeps parsing trivial.
    emit({"ok": True, "count": len(rows),
          "poets": [{"id": r[0], "name": r[1] or "", "poems": r[2]}
                    for r in rows]})


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
        poet_ids = _parse_poet_ids(sys.argv[3]) if len(sys.argv) > 3 else None
        cmd_beyt(db, poet_ids)
    elif cmd == "poets":
        cmd_poets(db)
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
