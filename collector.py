# collector.py
# RSSを収集してSQLiteに蓄積し、キーワードで検索できる最小構成
# 0円運用：GitHub Actionsで毎日実行 → db/news.db を更新（コミット）
#
# 使い方（ローカルで試す場合）:
#   python collector.py fetch
#   python collector.py search 中国 輸出 規制
#
# Actionsでは "fetch" を実行する

import sys
import sqlite3
import hashlib
from datetime import datetime, timezone, timedelta

try:
    import feedparser
except ImportError:
    print("feedparser not installed. Run: pip install feedparser", file=sys.stderr)
    raise

JST = timezone(timedelta(hours=9))

FEEDS = [
    ("JETRO", "https://www.jetro.go.jp/rss/biznews.xml"),
    ("中小企業庁", "https://www.chusho.meti.go.jp/rss/index.xml"),
]

DB_PATH = "db/news.db"
MAX_PER_FEED = 80  # 1フィードあたり最大取得数（多すぎ防止）


def now_iso():
    return datetime.now(JST).isoformat(timespec="seconds")


def to_iso(dt_struct) -> str:
    if not dt_struct:
        return now_iso()
    # feedparserのtime.struct_time
    dt = datetime(*dt_struct[:6], tzinfo=timezone.utc).astimezone(JST)
    return dt.isoformat(timespec="seconds")


def make_id(source: str, url: str) -> str:
    h = hashlib.sha256((source + "|" + url).encode("utf-8")).hexdigest()
    return h[:24]


def init_db(conn: sqlite3.Connection):
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          title TEXT NOT NULL,
          url TEXT NOT NULL,
          published TEXT,
          summary TEXT,
          fetched_at TEXT NOT NULL
        )
        """
    )
    cur.execute("CREATE INDEX IF NOT EXISTS idx_items_published ON items(published)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_items_source ON items(source)")
    conn.commit()


def upsert_item(conn, item):
    cur = conn.cursor()
    cur.execute(
        """
        INSERT OR IGNORE INTO items
        (id, source, title, url, published, summary, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            item["id"],
            item["source"],
            item["title"],
            item["url"],
            item["published"],
            item["summary"],
            item["fetched_at"],
        ),
    )
    return cur.rowcount  # 1なら追加、0なら既存


def fetch():
    import os

    os.makedirs("db", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    added_total = 0

    for source, url in FEEDS:
        d = feedparser.parse(url)

        entries = d.entries[:MAX_PER_FEED]
        for e in entries:
            title = (e.get("title") or "").strip()
            link = (e.get("link") or "").strip()
            if not link or not title:
                continue

            _id = make_id(source, link)
            published = to_iso(e.get("published_parsed") or e.get("updated_parsed"))
            summary = (e.get("summary") or e.get("description") or "").strip()

            item = {
                "id": _id,
                "source": source,
                "title": title,
                "url": link,
                "published": published,
                "summary": summary,
                "fetched_at": now_iso(),
            }

            added = upsert_item(conn, item)
            added_total += added

    conn.commit()
    conn.close()
    print(f"fetch done: added={added_total} db={DB_PATH}")


def search(keywords):
    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    # AND検索（全部含む）
    terms = [k.strip() for k in keywords if k.strip()]
    if not terms:
        print("No keywords.")
        return

    where = " AND ".join(["(title LIKE ? OR summary LIKE ?)"] * len(terms))
    params = []
    for t in terms:
        like = f"%{t}%"
        params += [like, like]

    sql = f"""
      SELECT published, source, title, url
      FROM items
      WHERE {where}
      ORDER BY published DESC
      LIMIT 100
    """

    cur = conn.cursor()
    rows = cur.execute(sql, params).fetchall()
    conn.close()

    for i, (published, source, title, url) in enumerate(rows, 1):
        print(f"{i}. [{source}] {published[:10]} {title}\n   {url}\n")

    print(f"hits={len(rows)}")


def main():
    if len(sys.argv) < 2:
        print("Usage: python collector.py fetch|search <keywords...>")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "fetch":
        fetch()
    elif cmd == "search":
        search(sys.argv[2:])
    else:
        print("Unknown command.")
        sys.exit(1)


if __name__ == "__main__":
    main()
