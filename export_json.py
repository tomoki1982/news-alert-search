# export_json.py
# db/news.db を docs/news.json に書き出す（GitHub Pages用）
import os, json, sqlite3

DB_PATH = "db/news.db"
OUT_PATH = "docs/news.json"

def main():
    if not os.path.exists(DB_PATH):
        print("DB not found:", DB_PATH)
        return

    os.makedirs("docs", exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    rows = cur.execute("""
        SELECT id, source, title, url, published, summary
        FROM items
        ORDER BY published DESC
        LIMIT 5000
    """).fetchall()
    conn.close()

    data = [
        {
            "id": r[0],
            "source": r[1],
            "title": r[2],
            "url": r[3],
            "published": r[4],
            "summary": r[5] or ""
        }
        for r in rows
    ]

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)

    print(f"exported {len(data)} -> {OUT_PATH}")

if __name__ == "__main__":
    main()
