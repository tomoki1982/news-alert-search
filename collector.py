# collector.py
import sys
import re
import sqlite3
import datetime
from typing import Optional, Dict, Any, List
import requests
import feedparser

DB_PATH = "db/news.db"

# いまはJETROだけ。増やすならここに追加するだけ
FEEDS = [
    {"source": "JETRO", "url": "https://www.jetro.go.jp/rss/biznews.xml"},
    # {"source": "中小企業庁", "url": "https://www.chusho.meti.go.jp/rss/index.xml"},
]

# 取り込み件数（重いなら減らす）
MAX_ITEMS_PER_FEED = 30

# ---- 分類ロジック（3分類） ----
# 規制・輸出
KW_REG = [
    r"輸出", r"輸入", r"輸出規制", r"輸入規制", r"規制", r"制裁", r"禁輸", r"管理",
    r"安全保障", r"エンドユーザー", r"リスト", r"該非", r"外為法", r"キャッチオール",
    r"関税", r"通商", r"WTO", r"FTA", r"EPA", r"輸出管理", r"輸入管理"
]

# 物価
KW_PRICE = [
    r"物価", r"CPI", r"PPI", r"インフレ", r"デフレ", r"価格", r"値上げ", r"値下げ",
    r"指数", r"コアCPI", r"消費者物価", r"企業物価", r"卸売物価"
]

def categorize(text: str) -> str:
    t = (text or "").strip()
    if not t:
        return "その他"

    for pat in KW_REG:
        if re.search(pat, t, flags=re.IGNORECASE):
            return "規制・輸出"

    for pat in KW_PRICE:
        if re.search(pat, t, flags=re.IGNORECASE):
            return "物価"

    return "その他"

# ---- DB ----
def connect_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    return conn

def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT NOT NULL UNIQUE,
      published TEXT,
      summary TEXT,
      fetched_at TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'その他'
    )
    """)
    # 既存DBに category 列がない場合に追加
    cols = [r[1] for r in conn.execute("PRAGMA table_info(news)").fetchall()]
    if "category" not in cols:
        conn.execute("ALTER TABLE news ADD COLUMN category TEXT NOT NULL DEFAULT 'その他'")
    conn.commit()

def upsert_item(conn: sqlite3.Connection, item: Dict[str, Any]) -> bool:
    """
    既にlinkがあれば更新、なければ追加
    戻り値: True=追加/更新があった、False=変化なし
    """
    cur = conn.cursor()
    cur.execute("SELECT title, published, summary, category FROM news WHERE link = ?", (item["link"],))
    row = cur.fetchone()

    if row is None:
        cur.execute("""
        INSERT INTO news (source, title, link, published, summary, fetched_at, category)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            item["source"], item["title"], item["link"],
            item.get("published"), item.get("summary"),
            item["fetched_at"], item["category"]
        ))
        return True

    # 既存がある場合は必要なら更新（タイトルや要約が変わることがある）
    old_title, old_pub, old_sum, old_cat = row
    changed = False
    if (old_title or "") != (item["title"] or ""):
        changed = True
    if (old_pub or "") != (item.get("published") or ""):
        changed = True
    if (old_sum or "") != (item.get("summary") or ""):
        changed = True
    if (old_cat or "") != (item.get("category") or ""):
        changed = True

    if changed:
        cur.execute("""
        UPDATE news
        SET source=?, title=?, published=?, summary=?, category=?
        WHERE link=?
        """, (
            item["source"], item["title"],
            item.get("published"), item.get("summary"),
            item["category"], item["link"]
        ))
        return True

    return False

# ---- RSS ----
def parse_published(entry: Any) -> Optional[str]:
    # feedparserのpublished_parsedを優先
    if getattr(entry, "published_parsed", None):
        dt = datetime.datetime(*entry.published_parsed[:6], tzinfo=datetime.timezone.utc)
        return dt.isoformat()
    pub = getattr(entry, "published", None) or getattr(entry, "updated", None)
    return pub

def clean_text(s: Optional[str]) -> str:
    if not s:
        return ""
    # 超ざっくりHTMLタグ除去（必要なら強化）
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s

def fetch_feed(url: str) -> feedparser.FeedParserDict:
    # タイムアウト短め（不安定対策）
    r = requests.get(url, timeout=15, headers={"User-Agent": "news-alert-search-bot"})
    r.raise_for_status()
    return feedparser.parse(r.text)

def run_fetch() -> None:
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    conn = connect_db()
    try:
        ensure_schema(conn)

        total_new = 0
        for f in FEEDS:
            src = f["source"]
            url = f["url"]
            try:
                d = fetch_feed(url)
            except Exception as e:
                print(f"[WARN] FETCH_FAIL {src} {url} {e}")
                continue

            entries = d.entries[:MAX_ITEMS_PER_FEED]
            for e in entries:
                title = clean_text(getattr(e, "title", "") or "")
                link = getattr(e, "link", "") or ""
                if not link:
                    continue

                summary_raw = getattr(e, "summary", None) or getattr(e, "description", None)
                summary = clean_text(summary_raw)
                published = parse_published(e)

                cat_text = f"{title} {summary}"
                category = categorize(cat_text)

                item = {
                    "source": src,
                    "title": title,
                    "link": link,
                    "published": published,
                    "summary": summary,
                    "fetched_at": now,
                    "category": category,
                }

                if upsert_item(conn, item):
                    total_new += 1

            conn.commit()
            print(f"[OK] {src} items={len(entries)} total_changed={total_new}")

        print(f"[DONE] total_changed={total_new}")

    finally:
        conn.close()

def main():
    cmd = (sys.argv[1:] or ["fetch"])[0]
    if cmd == "fetch":
        run_fetch()
    else:
        raise SystemExit("Usage: python collector.py fetch")

if __name__ == "__main__":
    main()
