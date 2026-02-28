import os
import json
import gzip
import shutil
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from dateutil.relativedelta import relativedelta

import feedparser
import requests

JST = ZoneInfo("Asia/Tokyo")

ROOT = Path(__file__).resolve().parents[1]
CONFIG_SOURCES = ROOT / "config" / "sources.json"

DOCS_DIR = ROOT / "docs"
DOCS_DATA_DIR = DOCS_DIR / "data"
INDEX_JSON = DOCS_DATA_DIR / "index.json"
LATEST_NDJSON = DOCS_DATA_DIR / "latest.ndjson"

ARCHIVE_DIR = ROOT / "archive"

KEEP_YEARS = 5
LATEST_MONTHS = 3

REQUEST_TIMEOUT = 25


def now_jst() -> datetime:
    return datetime.now(tz=JST)


def ensure_dirs():
    DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)


def load_sources():
    with open(CONFIG_SOURCES, "r", encoding="utf-8") as f:
        data = json.load(f)
    # enabled only
    return [s for s in data if s.get("enabled", True)]


def safe_text(s):
    if s is None:
        return ""
    return str(s).strip()


def parse_pubdate(entry) -> datetime | None:
    """
    feedparser gives:
      - published_parsed / updated_parsed (time.struct_time in UTC-ish)
      - published / updated strings
    We normalize to aware datetime UTC then convert to JST for month bucketing.
    """
    dt = None
    if hasattr(entry, "published_parsed") and entry.published_parsed:
        dt = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
    elif hasattr(entry, "updated_parsed") and entry.updated_parsed:
        dt = datetime(*entry.updated_parsed[:6], tzinfo=timezone.utc)

    if dt is None:
        # fallback: string parse (best effort)
        s = safe_text(getattr(entry, "published", "")) or safe_text(getattr(entry, "updated", ""))
        if s:
            try:
                # dateutil parser installed
                from dateutil import parser
                dt = parser.parse(s)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                else:
                    dt = dt.astimezone(timezone.utc)
            except Exception:
                dt = None
    return dt


def isoformat_z(dt_utc: datetime) -> str:
    # Keep UTC ISO with Z for consistency
    return dt_utc.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def month_key_from_dt(dt_utc: datetime) -> str:
    # Bucket by JST month based on publication time
    dt_jst = dt_utc.astimezone(JST)
    return f"{dt_jst.year:04d}-{dt_jst.month:02d}"


def archive_path_for_month(month_key: str) -> Path:
    yyyy, mm = month_key.split("-")
    d = ARCHIVE_DIR / yyyy
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{yyyy}-{mm}.ndjson.gz"


def read_ndjson_gz(path: Path) -> list[dict]:
    if not path.exists():
        return []
    items = []
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except Exception:
                # skip broken line
                continue
    return items


def write_ndjson_gz(path: Path, items: list[dict]):
    # write atomically
    tmp = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")
    tmp.replace(path)


def read_latest_links() -> set[str]:
    if not LATEST_NDJSON.exists():
        return set()
    links = set()
    with open(LATEST_NDJSON, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                it = json.loads(line)
                lk = it.get("link")
                if lk:
                    links.add(lk)
            except Exception:
                continue
    return links


def fetch_feed(url: str) -> feedparser.FeedParserDict:
    headers = {
        "User-Agent": "rss-collector/1.0 (+https://github.com/)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    }
    r = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    return feedparser.parse(r.content)


def normalize_entry(entry, source_name: str, source_category: str) -> dict | None:
    title = safe_text(getattr(entry, "title", ""))
    link = safe_text(getattr(entry, "link", ""))

    if not link or not title:
        return None

    dt = parse_pubdate(entry)
    if dt is None:
        # If no date, use "now" in UTC
        dt = datetime.now(timezone.utc)

    item = {
        "title": title,
        "link": link,
        "pubDate": isoformat_z(dt),
        "source": source_name,
        "category": source_category or "",
    }
    return item


def collect_all() -> list[dict]:
    sources = load_sources()
    out = []
    for s in sources:
        name = safe_text(s.get("name", s.get("id", "source")))
        url = safe_text(s.get("url", ""))
        category = safe_text(s.get("category", ""))

        if not url:
            continue

        try:
            feed = fetch_feed(url)
        except Exception as e:
            print(f"[WARN] fetch failed: {name} {url} -> {e}")
            continue

        entries = getattr(feed, "entries", []) or []
        for entry in entries:
            it = normalize_entry(entry, name, category)
            if it:
                out.append(it)

    # dedupe within batch by link, keep newest pubDate
    best = {}
    for it in out:
        lk = it["link"]
        if lk not in best:
            best[lk] = it
        else:
            # compare pubDate string (ISO Z) lexicographically works
            if it["pubDate"] > best[lk]["pubDate"]:
                best[lk] = it
    return list(best.values())


def upsert_archive(items: list[dict]) -> int:
    """
    Insert items into month files (gz).
    Dedupe by link within each month file + against current latest set.
    Returns count of newly added items.
    """
    latest_links = read_latest_links()

    # group by month key
    by_month = {}
    for it in items:
        dt = datetime.fromisoformat(it["pubDate"].replace("Z", "+00:00"))
        mk = month_key_from_dt(dt)
        by_month.setdefault(mk, []).append(it)

    added_total = 0

    for mk, arr in by_month.items():
        path = archive_path_for_month(mk)
        existing = read_ndjson_gz(path)

        existing_links = {x.get("link") for x in existing if x.get("link")}
        # also exclude anything in latest (helps cross-month re-post in short term)
        seen = existing_links | latest_links

        new_items = []
        for it in arr:
            if it["link"] in seen:
                continue
            new_items.append(it)
            seen.add(it["link"])

        if not new_items:
            continue

        # keep as "existing + new", sort by pubDate desc for readability
        merged = existing + new_items
        merged.sort(key=lambda x: x.get("pubDate", ""), reverse=True)
        write_ndjson_gz(path, merged)
        added_total += len(new_items)

    return added_total


def list_months_in_archive() -> list[str]:
    months = []
    if not ARCHIVE_DIR.exists():
        return months
    for year_dir in sorted(ARCHIVE_DIR.glob("[0-9][0-9][0-9][0-9]")):
        if not year_dir.is_dir():
            continue
        for f in sorted(year_dir.glob("*.ndjson.gz")):
            # filename "YYYY-MM.ndjson.gz"
            stem = f.name.replace(".ndjson.gz", "")
            if len(stem) == 7 and stem[4] == "-":
                months.append(stem)
    months = sorted(set(months))
    return months


def prune_old_archives():
    """
    Keep only last KEEP_YEARS worth by month (rolling).
    We delete months strictly older than (now - KEEP_YEARS) month start.
    """
    now = now_jst()
    cutoff = now - relativedelta(years=KEEP_YEARS)
    cutoff_month_start = datetime(cutoff.year, cutoff.month, 1, tzinfo=JST)

    # delete any month whose month-start < cutoff_month_start
    months = list_months_in_archive()
    for mk in months:
        y, m = mk.split("-")
        month_start = datetime(int(y), int(m), 1, tzinfo=JST)
        if month_start < cutoff_month_start:
            p = archive_path_for_month(mk)
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass

    # clean empty year directories
    for year_dir in ARCHIVE_DIR.glob("[0-9][0-9][0-9][0-9]"):
        if year_dir.is_dir():
            if not any(year_dir.glob("*.ndjson.gz")):
                try:
                    shutil.rmtree(year_dir)
                except Exception:
                    pass


def generate_index():
    months = list_months_in_archive()
    payload = {
        "generatedAt": now_jst().isoformat(timespec="seconds"),
        "keepYears": KEEP_YEARS,
        "latestMonths": LATEST_MONTHS,
        "minMonth": months[0] if months else None,
        "maxMonth": months[-1] if months else None,
        "months": months,
        "archivePathTemplate": "archive/{YYYY}/{YYYY-MM}.ndjson.gz",
    }
    with open(INDEX_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def months_back_list(n_months: int) -> list[str]:
    """
    Return list of month keys (YYYY-MM) for last n_months including current month, in ascending order.
    """
    now = now_jst()
    keys = []
    cur = datetime(now.year, now.month, 1, tzinfo=JST)
    for i in range(n_months):
        d = cur - relativedelta(months=i)
        keys.append(f"{d.year:04d}-{d.month:02d}")
    return sorted(keys)


def generate_latest():
    """
    latest.ndjson contains items from last LATEST_MONTHS months.
    We read month gz files, merge, dedupe by link, sort by pubDate desc.
    """
    want = set(months_back_list(LATEST_MONTHS))
    months = list_months_in_archive()
    target_months = [m for m in months if m in want]

    items = []
    for mk in target_months:
        p = archive_path_for_month(mk)
        items.extend(read_ndjson_gz(p))

    # dedupe by link keep newest pubDate
    best = {}
    for it in items:
        lk = it.get("link")
        if not lk:
            continue
        if lk not in best or it.get("pubDate", "") > best[lk].get("pubDate", ""):
            best[lk] = it

    merged = list(best.values())
    merged.sort(key=lambda x: x.get("pubDate", ""), reverse=True)

    # write plain NDJSON (not gz) for easy browser fetch
    with open(LATEST_NDJSON, "w", encoding="utf-8") as f:
        for it in merged:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")


def main():
    ensure_dirs()

    items = collect_all()
    print(f"[INFO] collected unique items from feeds: {len(items)}")

    added = upsert_archive(items)
    print(f"[INFO] newly added into archive: {added}")

    prune_old_archives()
    generate_index()
    generate_latest()

    print("[INFO] done")


if __name__ == "__main__":
    main()
