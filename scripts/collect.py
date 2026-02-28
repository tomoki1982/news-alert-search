import os
import json
import gzip
import shutil
import time
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from dateutil.relativedelta import relativedelta

import feedparser
import requests

JST = ZoneInfo("Asia/Tokyo")

ROOT = Path(__file__).resolve().parents[1]
CONFIG_SOURCES = ROOT / "config" / "sources.json"
CONFIG_CACHE = ROOT / "config" / "http_cache.json"

DOCS_DIR = ROOT / "docs"
DOCS_DATA_DIR = DOCS_DIR / "data"
INDEX_JSON = DOCS_DATA_DIR / "index.json"
LATEST_NDJSON = DOCS_DATA_DIR / "latest.ndjson"
FEED_METRICS_JSON = DOCS_DATA_DIR / "feed_metrics.json"

ARCHIVE_DIR = ROOT / "archive"

KEEP_YEARS = 5
LATEST_MONTHS = 3

REQUEST_TIMEOUT = 25


def now_jst() -> datetime:
    return datetime.now(tz=JST)


def ensure_dirs():
    DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    (ROOT / "config").mkdir(parents=True, exist_ok=True)


def load_sources():
    with open(CONFIG_SOURCES, "r", encoding="utf-8") as f:
        data = json.load(f)
    return [s for s in data if s.get("enabled", True)]


def load_http_cache() -> dict:
    if not CONFIG_CACHE.exists():
        return {}
    try:
        with open(CONFIG_CACHE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_http_cache(cache: dict):
    tmp = CONFIG_CACHE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    tmp.replace(CONFIG_CACHE)


def safe_text(s):
    if s is None:
        return ""
    return str(s).strip()


def parse_pubdate(entry) -> datetime | None:
    dt = None
    if hasattr(entry, "published_parsed") and entry.published_parsed:
        dt = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
    elif hasattr(entry, "updated_parsed") and entry.updated_parsed:
        dt = datetime(*entry.updated_parsed[:6], tzinfo=timezone.utc)

    if dt is None:
        s = safe_text(getattr(entry, "published", "")) or safe_text(getattr(entry, "updated", ""))
        if s:
            try:
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
    return dt_utc.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def month_key_from_dt(dt_utc: datetime) -> str:
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
                continue
    return items


def write_ndjson_gz(path: Path, items: list[dict]):
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


def fetch_feed(url: str, http_cache: dict) -> tuple[bytes | None, dict]:
    """
    Return (content_bytes or None if 304), and info dict.
    Uses ETag/Last-Modified cache when available.
    """
    headers = {
        "User-Agent": "rss-collector/1.0 (+https://github.com/)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    }

    cached = http_cache.get(url, {}) if isinstance(http_cache, dict) else {}
    etag = cached.get("etag")
    last_mod = cached.get("lastModified")

    if etag:
        headers["If-None-Match"] = etag
    if last_mod:
        headers["If-Modified-Since"] = last_mod

    t0 = time.monotonic()
    r = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    info = {
        "status": r.status_code,
        "elapsedMs": elapsed_ms,
        "bytes": len(r.content) if r.content else 0,
    }

    # cache update (even when 304 sometimes)
    new_etag = r.headers.get("ETag")
    new_last_mod = r.headers.get("Last-Modified")
    if new_etag or new_last_mod:
        http_cache[url] = {
            "etag": new_etag or etag or "",
            "lastModified": new_last_mod or last_mod or "",
            "updatedAt": now_jst().isoformat(timespec="seconds"),
        }

    if r.status_code == 304:
        return None, info

    r.raise_for_status()
    return r.content, info


def normalize_entry(entry, source_name: str, source_category: str) -> dict | None:
    title = safe_text(getattr(entry, "title", ""))
    link = safe_text(getattr(entry, "link", ""))

    if not link or not title:
        return None

    dt = parse_pubdate(entry)
    if dt is None:
        dt = datetime.now(timezone.utc)

    item = {
        "title": title,
        "link": link,
        "pubDate": isoformat_z(dt),
        "source": source_name,
        "category": source_category or "",
    }
    return item


def collect_all() -> tuple[list[dict], list[dict]]:
    sources = load_sources()
    http_cache = load_http_cache()

    out = []
    metrics = []

    for s in sources:
        name = safe_text(s.get("name", s.get("id", "source")))
        url = safe_text(s.get("url", ""))
        category = safe_text(s.get("category", ""))

        if not url:
            continue

        m = {
            "name": name,
            "url": url,
            "category": category,
            "status": None,
            "elapsedMs": None,
            "bytes": None,
            "items": 0,
            "error": "",
        }

        try:
            content, info = fetch_feed(url, http_cache)
            m["status"] = info.get("status")
            m["elapsedMs"] = info.get("elapsedMs")
            m["bytes"] = info.get("bytes")

            if content is None:
                # 304 Not Modified
                metrics.append(m)
                continue

            feed = feedparser.parse(content)
            entries = getattr(feed, "entries", []) or []
            for entry in entries:
                it = normalize_entry(entry, name, category)
                if it:
                    out.append(it)
                    m["items"] += 1

            metrics.append(m)

        except Exception as e:
            m["error"] = str(e)
            metrics.append(m)
            print(f"[WARN] fetch failed: {name} {url} -> {e}")
            continue

    # save http cache
    save_http_cache(http_cache)

    # dedupe within batch by link, keep newest pubDate
    best = {}
    for it in out:
        lk = it["link"]
        if lk not in best or it["pubDate"] > best[lk]["pubDate"]:
            best[lk] = it

    return list(best.values()), metrics


def upsert_archive(items: list[dict]) -> int:
    latest_links = read_latest_links()

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
        seen = existing_links | latest_links

        new_items = []
        for it in arr:
            if it["link"] in seen:
                continue
            new_items.append(it)
            seen.add(it["link"])

        if not new_items:
            continue

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
            stem = f.name.replace(".ndjson.gz", "")
            if len(stem) == 7 and stem[4] == "-":
                months.append(stem)
    return sorted(set(months))


def prune_old_archives():
    now = now_jst()
    cutoff = now - relativedelta(years=KEEP_YEARS)
    cutoff_month_start = datetime(cutoff.year, cutoff.month, 1, tzinfo=JST)

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

    for year_dir in ARCHIVE_DIR.glob("[0-9][0-9][0-9][0-9]"):
        if year_dir.is_dir() and not any(year_dir.glob("*.ndjson.gz")):
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
    now = now_jst()
    keys = []
    cur = datetime(now.year, now.month, 1, tzinfo=JST)
    for i in range(n_months):
        d = cur - relativedelta(months=i)
        keys.append(f"{d.year:04d}-{d.month:02d}")
    return sorted(keys)


def generate_latest():
    want = set(months_back_list(LATEST_MONTHS))
    months = list_months_in_archive()
    target_months = [m for m in months if m in want]

    items = []
    for mk in target_months:
        p = archive_path_for_month(mk)
        items.extend(read_ndjson_gz(p))

    best = {}
    for it in items:
        lk = it.get("link")
        if not lk:
            continue
        if lk not in best or it.get("pubDate", "") > best[lk].get("pubDate", ""):
            best[lk] = it

    merged = list(best.values())
    merged.sort(key=lambda x: x.get("pubDate", ""), reverse=True)

    with open(LATEST_NDJSON, "w", encoding="utf-8") as f:
        for it in merged:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")


def write_feed_metrics(metrics: list[dict]):
    payload = {
        "generatedAt": now_jst().isoformat(timespec="seconds"),
        "timeoutSec": REQUEST_TIMEOUT,
        "sources": metrics,
    }
    with open(FEED_METRICS_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def main():
    ensure_dirs()

    items, metrics = collect_all()
    print(f"[INFO] collected unique items from feeds: {len(items)}")

    added = upsert_archive(items)
    print(f"[INFO] newly added into archive: {added}")

    prune_old_archives()
    generate_index()
    generate_latest()
    write_feed_metrics(metrics)

    print("[INFO] done")


if __name__ == "__main__":
    main()
