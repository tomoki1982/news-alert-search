# export_json.py
import json
import sqlite3
from pathlib import Path

DB_PATH = "db/news.db"
OUT_PATH = Path("docs/news.json")

SNIPPET_LENGTH = 280  # スマホでちょうどいい文字数

def make_snippet(title: str, summary: str) -> str:
    text = (summary or "").strip()

    # summaryが空 or タイトルとほぼ同じ場合
    if not text or text == title:
        return ""

    if len(text) > SNIPPET_LENGTH:
        return text[:SNIPPET_LENGTH] + "…"
    return text

def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute("""
        SELECT source, title, link, published, summary, fetched_at, category
        FROM news
        ORDER BY COALESCE(published, fetched_at) DESC
        """).fetchall()

        items = []
        for r in rows:
            title = r["title"] or ""
            summary = r["summary"] or ""

            items.append({
                "source": r["source"],
                "title": title,
                "link": r["link"],
                "published": r["published"],
                "summary": summary,
                "snippet": make_snippet(title, summary),
                "fetchedAt": r["fetched_at"],
                "category": r["category"] or "その他",
            })

        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(
            json.dumps(items, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )
        print(f"[OK] wrote {OUT_PATH} items={len(items)}")
    finally:
        conn.close()

if __name__ == "__main__":
    main()
