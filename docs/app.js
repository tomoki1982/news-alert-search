/* docs/app.js
   News Finder - client app
   Robust field mapping for NDJSON entries.
*/

(() => {
  "use strict";

  const DATA_INDEX_URL = "data/index.json";
  const LATEST_NDJSON_URL = "data/latest.ndjson";
  const RSS_MEMO_KEY = "rssDraftList_v1";

  const $ = (sel) => document.querySelector(sel);

  function findFirstByIds(ids) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) return el;
    }
    return null;
  }

  // Try common ids (your HTML may differ; this tries to be tolerant)
  const elQuery = findFirstByIds(["q", "query", "keyword", "kw"]);
  const elSource = findFirstByIds(["source", "sourceSelect", "src", "sourceFilter", "source-filter"]);
  const elCategory = findFirstByIds(["category", "categorySelect", "cat", "categoryFilter", "category-filter"]);
  const elRange = findFirstByIds(["range", "rangeSelect", "period", "searchRange", "search-range"]);
  const btnSearch = findFirstByIds(["searchBtn", "btnSearch"]);
  const btnReset = findFirstByIds(["resetBtn", "btnReset"]);
  const listRoot = findFirstByIds(["results", "list", "resultList"]) || $("#results") || $("#list");
  const statusRoot = findFirstByIds(["status", "statusText", "info"]) || $("#status");

  let btnBulkCopy = findFirstByIds(["bulkCopyBtn", "btnBulkCopy"]);
  const rssMemoRoot = findFirstByIds(["rssMemo", "rss-memo", "rssMemoRoot"]) || $("#rssMemo");

  let ALL_ITEMS = [];
  let DISPLAY_ITEMS = [];

  // ---------- utils ----------
  const safeText = (v) => (v == null ? "" : String(v));
  const normalizeSpaces = (s) => safeText(s).replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();

  function parseQuery(q) {
    const raw = safeText(q).trim();
    if (!raw) return { orGroups: [] };
    const orParts = raw.split(/[|｜]/).map(p => normalizeSpaces(p)).filter(Boolean);
    const orGroups = orParts.map(part => part.split(" ").map(t => t.trim()).filter(Boolean));
    return { orGroups };
  }

  function itemText(it) {
    return [it.title, it.source, it.category, it.link].map(safeText).join(" ").toLowerCase();
  }

  function matchItemByQuery(it, parsed) {
    if (!parsed.orGroups || parsed.orGroups.length === 0) return true;
    const hay = itemText(it);
    return parsed.orGroups.some(andTerms => andTerms.every(term => hay.includes(term.toLowerCase())));
  }

  const uniq = (arr) => Array.from(new Set(arr));

  function isoToDateStr(iso) {
    if (!iso) return "";
    const d = new Date(String(iso));
    if (Number.isNaN(d.getTime())) return String(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}/${mm}/${dd} ${hh}:${mi}`;
  }

  function setStatus(msg) {
    if (statusRoot) statusRoot.textContent = msg;
  }

  function fallbackCopyText(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
  }

  function getSelectedValue(selectEl) {
    if (!selectEl) return "";
    return safeText(selectEl.value);
  }

  function buildOptions(selectEl, values, keepValue, labelAll = "すべて") {
    if (!selectEl) return;
    const current = keepValue ?? getSelectedValue(selectEl);
    const opts = [""].concat(values);

    selectEl.innerHTML = "";
    for (const v of opts) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v === "" ? labelAll : v;
      if (v === current) o.selected = true;
      selectEl.appendChild(o);
    }
  }

  // ---------- data load ----------
  async function fetchText(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
    return await res.text();
  }

  function pick(obj, keys, fallback = "") {
    for (const k of keys) {
      if (obj && obj[k] != null && String(obj[k]).trim() !== "") return String(obj[k]).trim();
    }
    return fallback;
  }

  async function loadLatest() {
    const text = await fetchText(LATEST_NDJSON_URL);
    const items = [];

    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);

        // Robust mapping (これで「すべてしか出ない」を潰す)
        const title = pick(obj, ["title", "headline", "subject"]);
        const link = pick(obj, ["link", "url", "href"]);
        const pubDate = pick(obj, ["pubDate", "published", "date", "updated", "time"]);
        const source = pick(obj, ["source", "sourceName", "name", "site", "publisher"]);
        const category = pick(obj, ["category", "cat", "topic", "section"]);

        items.push({
          title: safeText(title),
          link: safeText(link),
          pubDate: safeText(pubDate),
          source: safeText(source),
          category: safeText(category),
        });
      } catch (_) {
        // skip bad line
      }
    }

    items.sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""));
    return items;
  }

  // ---------- filtering ----------
  function applyFilters(items) {
    const q = elQuery ? elQuery.value : "";
    const parsed = parseQuery(q);

    const selSource = getSelectedValue(elSource);
    const selCategory = getSelectedValue(elCategory);

    return items.filter(it => {
      if (selSource && it.source !== selSource) return false;
      if (selCategory && it.category !== selCategory) return false;
      if (!matchItemByQuery(it, parsed)) return false;
      return true;
    });
  }

  function rebuildFilterOptionsBasedOn(itemsInScope) {
    // 0件になったら候補が消えるのを防ぐ（UIが醜くならん）
    const base = (itemsInScope && itemsInScope.length > 0) ? itemsInScope : ALL_ITEMS;

    const sources = uniq(base.map(it => it.source).filter(v => v && v.trim())).sort();
    const cats = uniq(base.map(it => it.category).filter(v => v && v.trim())).sort();

    const keepSource = getSelectedValue(elSource);
    const keepCat = getSelectedValue(elCategory);

    buildOptions(elSource, sources, keepSource, "ソース：すべて");
    buildOptions(elCategory, cats, keepCat, "カテゴリ：すべて");
  }

  // ---------- render ----------
  function createCard(it) {
    const card = document.createElement("div");
    card.className = "card";

    const h = document.createElement("div");
    h.className = "title";
    h.textContent = it.title || "(no title)";
    card.appendChild(h);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${it.source || "?"} / ${it.category || "?"} / ${isoToDateStr(it.pubDate)}`;
    card.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "actions";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn primary";
    open.textContent = "元記事を開く";
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      if (it.link) window.open(it.link, "_blank", "noopener,noreferrer");
    });

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn";
    copy.textContent = "URLコピー";
    copy.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!it.link) return;
      try {
        await navigator.clipboard.writeText(it.link);
        setStatus("URLコピーしたで");
      } catch {
        fallbackCopyText(it.link);
        setStatus("URLコピーしたで");
      }
    });

    actions.appendChild(open);
    actions.appendChild(copy);
    card.appendChild(actions);

    card.addEventListener("click", () => {
      if (it.link) window.open(it.link, "_blank", "noopener,noreferrer");
    });

    return card;
  }

  function render(items) {
    DISPLAY_ITEMS = items;

    if (!listRoot) return;
    listRoot.innerHTML = "";

    const frag = document.createDocumentFragment();
    for (const it of items) frag.appendChild(createCard(it));
    listRoot.appendChild(frag);

    setStatus(`表示 ${items.length} 件（全読み込み ${ALL_ITEMS.length} 件）`);
  }

  // ---------- bulk copy ----------
  async function bulkCopyUrls() {
    const urls = uniq(DISPLAY_ITEMS.map(it => it.link).filter(Boolean));
    if (urls.length === 0) return setStatus("コピーするURLがないわ");
    const text = urls.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`URLをまとめてコピーしたで（${urls.length}件）`);
    } catch {
      fallbackCopyText(text);
      setStatus(`URLをまとめてコピーしたで（${urls.length}件）`);
    }
  }

  function createBulkCopyButtonIfMissing() {
    if (btnBulkCopy) return;
    const host = (btnReset && btnReset.parentElement) || (btnSearch && btnSearch.parentElement) || (elQuery && elQuery.parentElement) || document.body;

    const b = document.createElement("button");
    b.type = "button";
    b.id = "bulkCopyBtn";
    b.className = "btn";
    b.textContent = "URLまとめてコピー";
    host.appendChild(b);
    btnBulkCopy = b;
  }

  // ---------- actions ----------
  function doSearchAndRender({ rebuildOptions = true } = {}) {
    const filtered = applyFilters(ALL_ITEMS);
    render(filtered);
    if (rebuildOptions) rebuildFilterOptionsBasedOn(filtered);
  }

  function doReset() {
    if (elQuery) elQuery.value = "";
    if (elSource) elSource.value = "";
    if (elCategory) elCategory.value = "";
    doSearchAndRender({ rebuildOptions: true });
  }

  function wireEvents() {
    createBulkCopyButtonIfMissing();
    if (btnBulkCopy) btnBulkCopy.addEventListener("click", bulkCopyUrls);

    if (btnSearch) btnSearch.addEventListener("click", () => doSearchAndRender({ rebuildOptions: true }));
    if (btnReset) btnReset.addEventListener("click", doReset);

    if (elSource) elSource.addEventListener("change", () => doSearchAndRender({ rebuildOptions: true }));
    if (elCategory) elCategory.addEventListener("change", () => doSearchAndRender({ rebuildOptions: true }));
    if (elRange) elRange.addEventListener("change", () => doSearchAndRender({ rebuildOptions: true }));

    if (elQuery) {
      elQuery.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doSearchAndRender({ rebuildOptions: true });
      });
    }
  }

  async function init() {
    setStatus("読み込み中...");
    try {
      ALL_ITEMS = await loadLatest();

      // 初期候補を全件から生成
      rebuildFilterOptionsBasedOn(ALL_ITEMS);

      // 初期表示
      doSearchAndRender({ rebuildOptions: true });

      setStatus(`準備OK（最新 ${ALL_ITEMS.length} 件）`);
    } catch (e) {
      console.error(e);
      setStatus("読み込みに失敗したわ（data/latest.ndjson を確認してな）");
    }

    wireEvents();
  }

  init();
})();
