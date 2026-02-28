/* docs/app.js
   News Finder - client app
   - load docs/data/latest.ndjson (latest 3 months)
   - optional load archive gz by year via docs/data/index.json (if UI has "past search" etc)
   - AND: spaces (half/full)
   - OR: | or ｜ (half/full)
   - Filter linkage: rebuild options based on current filtered results
   - Bulk URL copy: copy URLs of currently displayed results
   - RSS memo: localStorage draft list + export sources.json text
*/

(() => {
  "use strict";

  // ---------- Config ----------
  const DATA_INDEX_URL = "data/index.json";
  const LATEST_NDJSON_URL = "data/latest.ndjson";
  const RSS_MEMO_KEY = "rssDraftList_v1";

  // ---------- DOM helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function findFirstByIds(ids) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) return el;
    }
    return null;
  }

  // These IDs are guessed; app tolerates missing ones.
  const elQuery = findFirstByIds(["q", "query", "keyword", "kw"]);
  const elSource = findFirstByIds(["source", "sourceSelect", "src"]);
  const elCategory = findFirstByIds(["category", "categorySelect", "cat"]);
  const elRange = findFirstByIds(["range", "rangeSelect", "period"]);
  const btnSearch = findFirstByIds(["searchBtn", "btnSearch"]);
  const btnReset = findFirstByIds(["resetBtn", "btnReset"]);
  const btnPast = findFirstByIds(["pastBtn", "btnPast", "loadPastBtn"]); // optional
  const btnTheme = findFirstByIds(["themeBtn", "btnTheme"]); // optional
  const listRoot = findFirstByIds(["results", "list", "resultList"]) || $("#results") || $("#list");
  const statusRoot = findFirstByIds(["status", "statusText", "info"]) || $("#status");

  // Bulk copy button (we'll create if not exists)
  let btnBulkCopy = findFirstByIds(["bulkCopyBtn", "btnBulkCopy"]);

  // RSS memo UI (we'll create minimal UI if placeholders exist)
  const rssMemoRoot = findFirstByIds(["rssMemo", "rss-memo", "rssMemoRoot"]) || $("#rssMemo");

  // ---------- State ----------
  let ALL_ITEMS = [];        // latest loaded
  let DISPLAY_ITEMS = [];    // current filtered
  let LOADED_AT = null;

  // ---------- Utilities ----------
  function safeText(v) {
    return (v == null) ? "" : String(v);
  }

  function normalizeSpaces(s) {
    // Convert full-width spaces to half, collapse multiple
    return safeText(s).replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
  }

  function parseQuery(q) {
    // OR separator: | or ｜ (half/full)
    // AND separator: spaces (half/full)
    const raw = safeText(q).trim();
    if (!raw) return { orGroups: [] };

    const orParts = raw.split(/[|｜]/).map(p => normalizeSpaces(p)).filter(Boolean);
    const orGroups = orParts.map(part => part.split(" ").map(t => t.trim()).filter(Boolean));
    return { orGroups };
  }

  function itemText(it) {
    // searchable fields
    return [
      it.title,
      it.source,
      it.category,
      it.link
    ].map(safeText).join(" ").toLowerCase();
  }

  function matchItemByQuery(it, parsed) {
    if (!parsed.orGroups || parsed.orGroups.length === 0) return true;
    const hay = itemText(it);

    // OR across groups; AND within group
    return parsed.orGroups.some(andTerms => {
      return andTerms.every(term => {
        const t = term.toLowerCase();
        return hay.includes(t);
      });
    });
  }

  function uniq(arr) {
    return Array.from(new Set(arr));
  }

  function isoToDateStr(iso) {
    // Accept "Z" or "+00:00" iso
    if (!iso) return "";
    const s = safeText(iso);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    // YYYY/MM/DD HH:MM (local)
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

  function createButtonIfMissing() {
    if (!btnBulkCopy) {
      // Try append near search/reset if possible
      const host =
        (btnReset && btnReset.parentElement) ||
        (btnSearch && btnSearch.parentElement) ||
        (elQuery && elQuery.parentElement) ||
        document.body;

      const b = document.createElement("button");
      b.type = "button";
      b.id = "bulkCopyBtn";
      b.className = "btn";
      b.textContent = "URLまとめてコピー";
      host.appendChild(b);
      btnBulkCopy = b;
    }
  }

  // ---------- Data loading ----------
  async function fetchText(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${url}`);
    return await res.text();
  }

  async function loadLatest() {
    const text = await fetchText(LATEST_NDJSON_URL);
    const items = [];
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);
        // normalize keys
        items.push({
          title: safeText(obj.title),
          link: safeText(obj.link),
          pubDate: safeText(obj.pubDate),
          source: safeText(obj.source),
          category: safeText(obj.category),
        });
      } catch (_) {
        // skip
      }
    }
    // sort desc by pubDate
    items.sort((a, b) => (b.pubDate || "").localeCompare(a.pubDate || ""));
    return items;
  }

  // ---------- Filtering & rendering ----------
  function getSelectedValue(selectEl) {
    if (!selectEl) return "";
    return safeText(selectEl.value);
  }

  function buildOptions(selectEl, values, keepValue, labelAll = "すべて") {
    if (!selectEl) return;
    const current = keepValue ?? getSelectedValue(selectEl);
    const opts = [""].concat(values);

    // Rebuild
    selectEl.innerHTML = "";
    for (const v of opts) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v === "" ? labelAll : v;
      if (v === current) o.selected = true;
      selectEl.appendChild(o);
    }
  }

  function applyFilters(items) {
    const q = elQuery ? elQuery.value : "";
    const parsed = parseQuery(q);

    const selSource = getSelectedValue(elSource);
    const selCategory = getSelectedValue(elCategory);

    const out = items.filter(it => {
      if (selSource && it.source !== selSource) return false;
      if (selCategory && it.category !== selCategory) return false;
      if (!matchItemByQuery(it, parsed)) return false;
      return true;
    });

    return out;
  }

  function rebuildFilterOptionsBasedOn(itemsInScope) {
    // Build from current "scope" (usually filtered results)
    const sources = uniq(itemsInScope.map(it => it.source).filter(Boolean)).sort();
    const cats = uniq(itemsInScope.map(it => it.category).filter(Boolean)).sort();

    const keepSource = getSelectedValue(elSource);
    const keepCat = getSelectedValue(elCategory);

    buildOptions(elSource, sources, keepSource, "ソース：すべて");
    buildOptions(elCategory, cats, keepCat, "カテゴリ：すべて");
  }

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

    // tap card to open too (optional)
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

  function fallbackCopyText(text) {
    // Old browsers
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

  async function bulkCopyUrls() {
    const urls = uniq(DISPLAY_ITEMS.map(it => it.link).filter(Boolean));
    if (urls.length === 0) {
      setStatus("コピーするURLがないわ");
      return;
    }
    const text = urls.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`URLをまとめてコピーしたで（${urls.length}件）`);
    } catch {
      fallbackCopyText(text);
      setStatus(`URLをまとめてコピーしたで（${urls.length}件）`);
    }
  }

  function doSearchAndRender({ rebuildOptions = true } = {}) {
    const filtered = applyFilters(ALL_ITEMS);

    render(filtered);

    // Filter linkage (改善案①):
    // rebuild options based on "filtered results BEFORE applying each filter" would be complex.
    // Here: rebuild based on filtered results AFTER current selections.
    if (rebuildOptions) rebuildFilterOptionsBasedOn(filtered);
  }

  function doReset() {
    if (elQuery) elQuery.value = "";
    if (elSource) elSource.value = "";
    if (elCategory) elCategory.value = "";
    if (elRange) {
      // if range has option like "直近3か月" value exists, keep as-is.
      // otherwise do nothing
    }
    doSearchAndRender({ rebuildOptions: true });
  }

  // ---------- RSS memo ----------
  function loadRssDraftList() {
    try {
      return JSON.parse(localStorage.getItem(RSS_MEMO_KEY) || "[]");
    } catch {
      return [];
    }
  }

  function saveRssDraftList(list) {
    localStorage.setItem(RSS_MEMO_KEY, JSON.stringify(list));
  }

  function makeIdFrom(name, url) {
    const base = (name || "rss") + "_" + (url || "");
    return base
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || ("rss_" + Date.now());
  }

  function renderRssMemoUI() {
    if (!rssMemoRoot) return;

    // Clear then build
    rssMemoRoot.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "card";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "RSS追加メモ（GitHubのsources.json用）";
    wrap.appendChild(title);

    const form = document.createElement("div");
    form.className = "rss-form";

    const inName = document.createElement("input");
    inName.type = "text";
    inName.placeholder = "名前（例：日経新聞）";

    const inUrl = document.createElement("input");
    inUrl.type = "text";
    inUrl.placeholder = "RSS URL（https://...）";

    const inCat = document.createElement("input");
    inCat.type = "text";
    inCat.placeholder = "カテゴリ（例：政治・経済）";

    const btnAdd = document.createElement("button");
    btnAdd.type = "button";
    btnAdd.className = "btn";
    btnAdd.textContent = "メモに追加";

    form.appendChild(inName);
    form.appendChild(inUrl);
    form.appendChild(inCat);
    form.appendChild(btnAdd);
    wrap.appendChild(form);

    const actions = document.createElement("div");
    actions.className = "actions";

    const btnExport = document.createElement("button");
    btnExport.type = "button";
    btnExport.className = "btn";
    btnExport.textContent = "sources.json を生成してコピー";

    const btnClear = document.createElement("button");
    btnClear.type = "button";
    btnClear.className = "btn";
    btnClear.textContent = "メモ全消し";

    actions.appendChild(btnExport);
    actions.appendChild(btnClear);
    wrap.appendChild(actions);

    const list = document.createElement("div");
    list.className = "rss-list";
    wrap.appendChild(list);

    function refreshList() {
      const arr = loadRssDraftList();
      list.innerHTML = "";
      if (arr.length === 0) {
        const p = document.createElement("div");
        p.className = "muted";
        p.textContent = "まだメモは空やで。";
        list.appendChild(p);
        return;
      }

      arr.forEach((it, idx) => {
        const row = document.createElement("div");
        row.className = "rss-row";

        const left = document.createElement("div");
        left.className = "rss-row-main";
        left.textContent = `${it.name} / ${it.category} / ${it.url}`;
        row.appendChild(left);

        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn";
        del.textContent = "削除";
        del.addEventListener("click", () => {
          const cur = loadRssDraftList();
          cur.splice(idx, 1);
          saveRssDraftList(cur);
          refreshList();
        });
        row.appendChild(del);

        list.appendChild(row);
      });
    }

    btnAdd.addEventListener("click", () => {
      const name = normalizeSpaces(inName.value);
      const url = normalizeSpaces(inUrl.value);
      const cat = normalizeSpaces(inCat.value);

      if (!url || !/^https?:\/\//i.test(url)) {
        setStatus("RSS URLが変やで（https:// から始めてな）");
        return;
      }

      const arr = loadRssDraftList();
      // prevent duplicates by url
      if (arr.some(x => x.url === url)) {
        setStatus("そのRSSはもうメモにあるで");
        return;
      }

      arr.push({
        id: makeIdFrom(name, url),
        name: name || "RSS",
        url,
        enabled: true,
        frequency: "hourly",
        category: cat || ""
      });
      saveRssDraftList(arr);

      inUrl.value = "";
      setStatus("RSSをメモに追加したで");
      refreshList();
    });

    btnExport.addEventListener("click", async () => {
      const arr = loadRssDraftList();
      const text = JSON.stringify(arr, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        setStatus("sources.json をコピーしたで（GitHubに貼ってな）");
      } catch {
        fallbackCopyText(text);
        setStatus("sources.json をコピーしたで（GitHubに貼ってな）");
      }
    });

    btnClear.addEventListener("click", () => {
      if (!confirm("RSSメモを全部消すで？")) return;
      saveRssDraftList([]);
      setStatus("RSSメモを全消ししたで");
      refreshList();
    });

    refreshList();
    rssMemoRoot.appendChild(wrap);
  }

  // ---------- Wire events ----------
  function wireEvents() {
    createButtonIfMissing();
    if (btnBulkCopy) btnBulkCopy.addEventListener("click", bulkCopyUrls);

    if (btnSearch) btnSearch.addEventListener("click", () => doSearchAndRender({ rebuildOptions: true }));
    if (btnReset) btnReset.addEventListener("click", doReset);

    // Auto search when filters change (good UX on mobile)
    if (elSource) elSource.addEventListener("change", () => doSearchAndRender({ rebuildOptions: true }));
    if (elCategory) elCategory.addEventListener("change", () => doSearchAndRender({ rebuildOptions: true }));
    if (elRange) elRange.addEventListener("change", () => doSearchAndRender({ rebuildOptions: true }));

    if (elQuery) {
      elQuery.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doSearchAndRender({ rebuildOptions: true });
      });
    }

    renderRssMemoUI();
  }

  // ---------- Init ----------
  async function init() {
    setStatus("読み込み中...");
    try {
      ALL_ITEMS = await loadLatest();
      LOADED_AT = new Date();
      // initial options from all items
      const sources = uniq(ALL_ITEMS.map(it => it.source).filter(Boolean)).sort();
      const cats = uniq(ALL_ITEMS.map(it => it.category).filter(Boolean)).sort();
      buildOptions(elSource, sources, getSelectedValue(elSource), "ソース：すべて");
      buildOptions(elCategory, cats, getSelectedValue(elCategory), "カテゴリ：すべて");

      // Default: show all latest (search range is handled outside via data generation)
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
