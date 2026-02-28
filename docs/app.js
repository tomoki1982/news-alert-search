/* docs/app.js
   News Finder (GitHub Pages)
   - data: docs/data/latest.ndjson (last N months)
   - index: docs/data/index.json (archive months list)
   - archive: archive/YYYY/YYYY-MM.ndjson.gz (optional; only when user expands range)
   Features:
   - AND: space (全角/半角) or AND button
   - OR : OR button or "|" / "｜"
   - Source/Category linked filter (改善案①)
   - URLまとめてコピー (現在の表示リスト分)
   - RSS追加メモ (ローカル保存) : URL/名前/カテゴリをメモ
*/

(() => {
  "use strict";

  // ---------- Config ----------
  const PATH_INDEX = "docs/data/index.json".replace(/^docs\//, "data/"); // GitHub Pages: /docs is root, so use "data/.."
  const PATH_LATEST = "docs/data/latest.ndjson".replace(/^docs\//, "data/");
  const PATH_FEED_METRICS = "docs/data/feed_metrics.json".replace(/^docs\//, "data/");
  const ARCHIVE_TEMPLATE = "archive/{YYYY}/{YYYY-MM}.ndjson.gz";

  const DEFAULT_RANGE = "latest3m"; // UI default
  const MAX_KEEP_YEARS = 5;

  const STORAGE_KEY_THEME = "nf_theme";
  const STORAGE_KEY_RSS_MEMO = "nf_rss_memo_v1";

  // ---------- DOM helpers ----------
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === null || v === undefined) continue;
      else node.setAttribute(k, String(v));
    }
    for (const c of children) node.append(c);
    return node;
  };

  const escapeHtml = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  // ---------- State ----------
  const STATE = {
    index: null,
    latestItems: [],
    // Loaded items used for search (depends on range)
    pool: [],
    // Map monthKey -> items loaded (from archive)
    monthCache: new Map(),
    // UI selections
    queryText: "",
    source: "ALL",
    category: "ALL",
    range: DEFAULT_RANGE, // latest3m / y1 / y2 / y3 / y4 / y5
    // derived
    availableSources: [],
    availableCategories: [],
    // result
    results: [],
    // display
    displayLimit: 30,
  };

  // ---------- Parsing & search ----------
  function normalizeQueryText(s) {
    return String(s ?? "").trim();
  }

  function splitORGroups(q) {
    // OR separators: | or ｜ or OR keyword (case-insensitive) surrounded by spaces
    // We also treat " OR " typed by user.
    const s = normalizeQueryText(q);
    if (!s) return [];
    // Replace " OR " / " or " (with spaces around) into |
    const t = s.replace(/\s+OR\s+/gi, " | ").replace(/\s+or\s+/g, " | ");
    // Split by pipes (either half/full)
    return t.split(/[|｜]/).map((x) => x.trim()).filter(Boolean);
  }

  function splitANDTerms(group) {
    // AND separators: spaces (half/full) (collapse multiple)
    // keep quoted phrases? (not now). Simple split.
    const g = normalizeQueryText(group);
    if (!g) return [];
    return g
      .split(/[ \u3000]+/g) // half/full space
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function itemTextForSearch(it) {
    // Search over title/source/category/url (as you requested)
    const parts = [
      it.title ?? "",
      it.source ?? "",
      it.category ?? "",
      it.link ?? "",
    ];
    return parts.join(" ").toLowerCase();
  }

  function matchQuery(it, query) {
    const groups = splitORGroups(query);
    if (groups.length === 0) return true;

    const hay = itemTextForSearch(it);

    // OR across groups; AND within a group
    for (const g of groups) {
      const terms = splitANDTerms(g);
      if (terms.length === 0) continue;
      let ok = true;
      for (const term of terms) {
        const t = term.toLowerCase();
        if (!hay.includes(t)) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  function filterItems(items) {
    const q = normalizeQueryText(STATE.queryText);
    const s = STATE.source;
    const c = STATE.category;

    return items.filter((it) => {
      if (s !== "ALL" && (it.source ?? "") !== s) return false;
      if (c !== "ALL" && (it.category ?? "") !== c) return false;
      if (!matchQuery(it, q)) return false;
      return true;
    });
  }

  // ---------- Date helpers ----------
  function parseISOZ(s) {
    // "2026-02-28T10:00:00Z" or ISO with offset
    try {
      return new Date(s);
    } catch {
      return null;
    }
  }

  function fmtDate(iso) {
    const d = parseISOZ(iso);
    if (!d || isNaN(d.getTime())) return "";
    // JST-like display (browser locale); keep compact
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${y}/${m}/${da} ${hh}:${mm}`;
  }

  // ---------- Fetch / load ----------
  async function fetchText(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.text();
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  }

  function parseNdjson(text) {
    const out = [];
    const lines = text.split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        // ignore broken line
      }
    }
    return out;
  }

  // Minimal ungzip for .gz archive in browser:
  // We'll use built-in DecompressionStream when available.
  async function fetchGzNdjson(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const blob = await res.blob();

    if ("DecompressionStream" in window) {
      const ds = new DecompressionStream("gzip");
      const stream = blob.stream().pipeThrough(ds);
      const decompressed = await new Response(stream).text();
      return parseNdjson(decompressed);
    }
    // If not supported, we can't read gz; fallback: no archive.
    throw new Error("このブラウザはgzip解凍に対応してへん（DecompressionStream無し）");
  }

  function uniqueByLink(items) {
    const best = new Map();
    for (const it of items) {
      const link = it.link;
      if (!link) continue;
      const cur = best.get(link);
      if (!cur) best.set(link, it);
      else {
        const a = it.pubDate ?? "";
        const b = cur.pubDate ?? "";
        if (a > b) best.set(link, it);
      }
    }
    return Array.from(best.values());
  }

  function sortByPubDesc(items) {
    items.sort((a, b) => (b.pubDate ?? "").localeCompare(a.pubDate ?? ""));
    return items;
  }

  async function loadIndexAndLatest() {
    // index.json is optional but recommended
    try {
      STATE.index = await fetchJSON(PATH_INDEX);
    } catch {
      STATE.index = null;
    }

    const latestText = await fetchText(PATH_LATEST);
    STATE.latestItems = sortByPubDesc(uniqueByLink(parseNdjson(latestText)));

    // initial pool is latestItems
    STATE.pool = STATE.latestItems.slice();
  }

  function computeTargetMonthsForRange(rangeKey) {
    // rangeKey: latest3m / y1 / y2 / y3 / y4 / y5
    // We interpret: latest3m = rely on latest.ndjson
    // Others: last N years (rolling months) including current month, up to keepYears.
    const y = rangeKey.startsWith("y") ? Math.min(parseInt(rangeKey.slice(1), 10) || 1, MAX_KEEP_YEARS) : 0;
    if (!y) return [];
    // Need months list from index.json; if unavailable, cannot expand.
    const months = STATE.index?.months ?? [];
    if (!months.length) return [];

    // Take last y years worth months from the end.
    const take = Math.min(months.length, y * 12);
    return months.slice(months.length - take);
  }

  async function ensurePoolForRange(rangeKey) {
    if (rangeKey === "latest3m") {
      STATE.pool = STATE.latestItems.slice();
      return;
    }

    const months = computeTargetMonthsForRange(rangeKey);
    if (!months.length) {
      // fallback: latest only
      STATE.pool = STATE.latestItems.slice();
      return;
    }

    const all = [];
    for (const mk of months) {
      if (STATE.monthCache.has(mk)) {
        all.push(...STATE.monthCache.get(mk));
        continue;
      }
      const yyyy = mk.slice(0, 4);
      const url = ARCHIVE_TEMPLATE.replace("{YYYY}", yyyy).replace("{YYYY-MM}", mk);
      try {
        const items = await fetchGzNdjson(url);
        const uniq = uniqueByLink(items);
        STATE.monthCache.set(mk, uniq);
        all.push(...uniq);
      } catch (e) {
        // If some months fail, just skip them (do not break UI)
        // console.warn(e);
      }
    }
    // Merge with latest just in case (some browsers cannot read gz)
    const merged = uniqueByLink([...all, ...STATE.latestItems]);
    STATE.pool = sortByPubDesc(merged);
  }

  // ---------- UI: build controls ----------
  function buildUI() {
    // Expect existing layout in index.html:
    // #q, #btnAnd, #btnOr, #selSource, #selCategory, #selRange, #btnSearch, #btnReset,
    // #btnCopyAll, #list, #count, #themeBtn, #rssMemoBtn
    // (If not exist, we create minimal UI)

    // Ensure buttons exist
    if (!qs("#themeBtn")) {
      // Minimal fallback
      const header = qs("header") || document.body;
      header.append(el("button", { id: "themeBtn", text: "🌙" }));
    }
    if (!qs("#rssMemoBtn")) {
      const header = qs("header") || document.body;
      header.append(el("button", { id: "rssMemoBtn", text: "RSS追加メモ" }));
    }
    if (!qs("#btnCopyAll")) {
      const controls = qs("#controls") || document.body;
      controls.append(el("button", { id: "btnCopyAll", text: "URLまとめてコピー" }));
    }

    // Wire events
    qs("#btnSearch")?.addEventListener("click", onSearch);
    qs("#btnReset")?.addEventListener("click", onReset);

    qs("#q")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onSearch();
    });

    qs("#btnAnd")?.addEventListener("click", () => insertToken(" "));
    qs("#btnOr")?.addEventListener("click", () => insertToken(" | "));

    qs("#selSource")?.addEventListener("change", () => {
      STATE.source = qs("#selSource").value;
      // Linked filter (改善案①): if source fixed, categories narrow; if category fixed, sources narrow
      refreshLinkedOptions();
      // do not auto-search; keep calm
      renderCountOnly();
    });

    qs("#selCategory")?.addEventListener("change", () => {
      STATE.category = qs("#selCategory").value;
      refreshLinkedOptions();
      renderCountOnly();
    });

    qs("#selRange")?.addEventListener("change", async () => {
      STATE.range = qs("#selRange").value;
      await ensurePoolForRange(STATE.range);
      refreshLinkedOptions(true); // rebuild options from new pool
      onSearch();
    });

    qs("#btnCopyAll")?.addEventListener("click", copyAllUrls);

    qs("#themeBtn")?.addEventListener("click", toggleTheme);
    qs("#rssMemoBtn")?.addEventListener("click", openRssMemo);

    // No "準備中..." / "表示0件" legacy texts: do not create those nodes here.
  }

  function insertToken(token) {
    const input = qs("#q");
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    input.value = before + token + after;
    const pos = (before + token).length;
    input.focus();
    input.setSelectionRange(pos, pos);
  }

  function getDistinctValues(items, field) {
    const set = new Set();
    for (const it of items) {
      const v = (it[field] ?? "").trim?.() ? it[field].trim() : (it[field] ?? "");
      if (v) set.add(v);
    }
    return Array.from(set).sort((a, b) => String(a).localeCompare(String(b), "ja"));
  }

  function setSelectOptions(selectEl, values, keepValue) {
    if (!selectEl) return;
    const cur = keepValue ?? selectEl.value ?? "ALL";

    selectEl.innerHTML = "";
    selectEl.append(el("option", { value: "ALL", text: "すべて" }));
    for (const v of values) selectEl.append(el("option", { value: v, text: v }));

    // restore if possible
    if (cur && (cur === "ALL" || values.includes(cur))) selectEl.value = cur;
    else selectEl.value = "ALL";
  }

  function refreshLinkedOptions(rebuildFromPool = false) {
    // 改善案①:
    // - 元データは「現在のpool」
    // - source選択がALLなら category一覧は pool全体から（ただしcategory選択が固定ならsource一覧はそのcategoryで絞る）
    // - category選択がALLなら source一覧は pool全体から（ただしsource選択が固定ならcategory一覧はそのsourceで絞る）
    const pool = rebuildFromPool ? STATE.pool : STATE.pool;

    const curSource = qs("#selSource")?.value ?? STATE.source;
    const curCategory = qs("#selCategory")?.value ?? STATE.category;

    STATE.source = curSource;
    STATE.category = curCategory;

    // categories list
    let catBase = pool;
    if (curSource !== "ALL") catBase = pool.filter((it) => (it.source ?? "") === curSource);
    const categories = getDistinctValues(catBase, "category");

    // sources list
    let srcBase = pool;
    if (curCategory !== "ALL") srcBase = pool.filter((it) => (it.category ?? "") === curCategory);
    const sources = getDistinctValues(srcBase, "source");

    STATE.availableSources = sources;
    STATE.availableCategories = categories;

    setSelectOptions(qs("#selSource"), sources, curSource);
    setSelectOptions(qs("#selCategory"), categories, curCategory);
  }

  function buildRangeOptions() {
    const sel = qs("#selRange");
    if (!sel) return;

    // We always show 直近3か月 (標準), then 直近1年..5年
    sel.innerHTML = "";
    sel.append(el("option", { value: "latest3m", text: "直近3か月（標準）" }));
    sel.append(el("option", { value: "y1", text: "直近1年" }));
    sel.append(el("option", { value: "y2", text: "直近2年" }));
    sel.append(el("option", { value: "y3", text: "直近3年" }));
    sel.append(el("option", { value: "y4", text: "直近4年" }));
    sel.append(el("option", { value: "y5", text: "直近5年" }));

    sel.value = STATE.range;
  }

  // ---------- Rendering ----------
  function renderCountOnly() {
    // Keep it minimal: only show count area, do not show "準備中..." / "表示0件" legacy labels.
    const countEl = qs("#count");
    if (!countEl) return;
    // We'll show current loaded size only.
    countEl.textContent = `全読み込み ${STATE.pool.length} 件`;
  }

  function renderResults(list) {
    const listEl = qs("#list");
    if (!listEl) return;
    listEl.innerHTML = "";

    const show = list.slice(0, STATE.displayLimit);

    for (const it of show) {
      const title = escapeHtml(it.title ?? "");
      const source = escapeHtml(it.source ?? "");
      const category = escapeHtml(it.category ?? "");
      const dateText = fmtDate(it.pubDate ?? "");
      const link = it.link ?? "";

      const metaLine = el("div", { class: "meta" }, [
        el("span", { class: "pill", text: source || "?" }),
        category ? el("span", { class: "pill pill-lite", text: category }) : el("span", { class: "pill pill-lite", text: "" }),
        dateText ? el("span", { class: "dt", text: dateText }) : el("span", { class: "dt", text: "" }),
      ]);

      const btnOpen = el("button", {
        class: "btn btn-primary",
        text: "元記事を開く",
        onclick: () => {
          if (link) window.open(link, "_blank", "noopener,noreferrer");
        },
      });

      const btnCopy = el("button", {
        class: "btn",
        text: "URLコピー",
        onclick: async () => {
          if (!link) return;
          await copyToClipboard(link);
          toast("URLコピーしたで");
        },
      });

      const actions = el("div", { class: "actions" }, [btnOpen, btnCopy]);

      const card = el("div", { class: "card" }, [
        el("div", { class: "title", text: it.title ?? "" }),
        metaLine,
        actions,
      ]);

      // Card click also opens (optional; if you prefer button only, comment out)
      card.addEventListener("click", (e) => {
        // ignore button clicks
        if (e.target && (e.target.tagName === "BUTTON" || e.target.closest("button"))) return;
        if (link) window.open(link, "_blank", "noopener,noreferrer");
      });

      listEl.append(card);
    }

    // count header
    const countEl = qs("#count");
    if (countEl) {
      const total = list.length;
      const loaded = STATE.pool.length;
      const shown = Math.min(total, STATE.displayLimit);
      countEl.textContent = `表示 ${shown} 件（該当 ${total} 件 / 全読み込み ${loaded} 件）`;
    }
  }

  // ---------- Clipboard ----------
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback
      const ta = el("textarea", { style: "position:fixed;left:-9999px;top:-9999px;" });
      ta.value = text;
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  async function copyAllUrls() {
    // Copy current rendered result URLs (filtered results)
    if (!STATE.results.length) {
      toast("コピーするURLがないで");
      return;
    }
    const urls = STATE.results.map((x) => x.link).filter(Boolean);
    const text = urls.join("\n");
    await copyToClipboard(text);
    toast(`URLをまとめてコピーしたで（${urls.length}件）`);
  }

  // ---------- Theme ----------
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY_THEME, theme);
    } catch {}
    const btn = qs("#themeBtn");
    if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  }

  function toggleTheme() {
    const cur = document.documentElement.dataset.theme || "light";
    applyTheme(cur === "dark" ? "light" : "dark");
  }

  function initTheme() {
    let theme = "light";
    try {
      theme = localStorage.getItem(STORAGE_KEY_THEME) || "light";
    } catch {}
    applyTheme(theme);
  }

  // ---------- RSS Memo (local) ----------
  function loadRssMemo() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_RSS_MEMO);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function saveRssMemo(list) {
    try {
      localStorage.setItem(STORAGE_KEY_RSS_MEMO, JSON.stringify(list, null, 2));
    } catch {}
  }

  function openRssMemo() {
    // modal
    const overlay = el("div", { class: "modal-overlay" });
    const modal = el("div", { class: "modal" });

    const header = el("div", { class: "modal-head" }, [
      el("div", { class: "modal-title", text: "RSS追加メモ" }),
      el("button", { class: "btn", text: "閉じる", onclick: () => overlay.remove() }),
    ]);

    const note = el("div", { class: "modal-note", text: "ここはメモやで。収集対象に反映はされへん（sources.jsonはGitHubで編集）。URL/名前/カテゴリを控えておく用。" });

    const form = el("div", { class: "modal-form" });

    const inputName = el("input", { class: "input", placeholder: "名前（例：日経新聞）" });
    const inputUrl = el("input", { class: "input", placeholder: "RSS URL（https://...）" });
    const inputCat = el("input", { class: "input", placeholder: "カテゴリ（例：速報 / 公的 / 倒産）" });

    const btnAdd = el("button", {
      class: "btn btn-primary",
      text: "メモに追加",
      onclick: () => {
        const name = normalizeQueryText(inputName.value);
        const url = normalizeQueryText(inputUrl.value);
        const cat = normalizeQueryText(inputCat.value);
        if (!url) {
          toast("URLは必須やで");
          return;
        }
        const list = loadRssMemo();
        list.unshift({ name: name || "(未入力)", url, category: cat || "", addedAt: new Date().toISOString() });
        saveRssMemo(list);
        renderMemoList();
        inputName.value = "";
        inputUrl.value = "";
        inputCat.value = "";
        toast("追加したで");
      },
    });

    const btnCopy = el("button", {
      class: "btn",
      text: "メモ一覧をコピー",
      onclick: async () => {
        const list = loadRssMemo();
        if (!list.length) return toast("メモが空やで");
        const text = list
          .map((x) => `${x.name}\t${x.category}\t${x.url}`)
          .join("\n");
        await copyToClipboard(text);
        toast("メモ一覧コピーしたで");
      },
    });

    const btnClear = el("button", {
      class: "btn",
      text: "全部削除",
      onclick: () => {
        if (!confirm("RSS追加メモを全部消すで？")) return;
        saveRssMemo([]);
        renderMemoList();
      },
    });

    form.append(
      el("div", { class: "row" }, [inputName]),
      el("div", { class: "row" }, [inputUrl]),
      el("div", { class: "row" }, [inputCat]),
      el("div", { class: "row actions" }, [btnAdd, btnCopy, btnClear])
    );

    const listWrap = el("div", { class: "memo-list" });
    const renderMemoList = () => {
      listWrap.innerHTML = "";
      const list = loadRssMemo();
      if (!list.length) {
        listWrap.append(el("div", { class: "muted", text: "（まだメモはないで）" }));
        return;
      }
      for (const x of list.slice(0, 200)) {
        const row = el("div", { class: "memo-row" }, [
          el("div", { class: "memo-main" }, [
            el("div", { class: "memo-name", text: x.name ?? "" }),
            el("div", { class: "memo-sub muted", text: `${x.category ?? ""}` }),
            el("div", { class: "memo-url", text: x.url ?? "" }),
          ]),
          el("div", { class: "memo-actions" }, [
            el("button", {
              class: "btn",
              text: "URLコピー",
              onclick: async () => {
                await copyToClipboard(x.url ?? "");
                toast("URLコピーしたで");
              },
            }),
            el("button", {
              class: "btn",
              text: "削除",
              onclick: () => {
                const all = loadRssMemo();
                const idx = all.findIndex((a) => a.addedAt === x.addedAt && a.url === x.url);
                if (idx >= 0) {
                  all.splice(idx, 1);
                  saveRssMemo(all);
                  renderMemoList();
                }
              },
            }),
          ]),
        ]);
        listWrap.append(row);
      }
    };

    renderMemoList();

    modal.append(header, note, form, listWrap);
    overlay.append(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.append(overlay);
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg) {
    let t = qs("#toast");
    if (!t) {
      t = el("div", { id: "toast", class: "toast" });
      document.body.append(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1600);
  }

  // ---------- Actions ----------
  async function onSearch() {
    const qEl = qs("#q");
    if (qEl) STATE.queryText = qEl.value;

    // Make sure pool matches range
    await ensurePoolForRange(STATE.range);

    // Linked options should consider current selection (and range)
    refreshLinkedOptions(true);

    // Filter
    const res = filterItems(STATE.pool);
    STATE.results = sortByPubDesc(res);

    renderResults(STATE.results);
  }

  async function onReset() {
    const qEl = qs("#q");
    if (qEl) qEl.value = "";
    STATE.queryText = "";
    STATE.source = "ALL";
    STATE.category = "ALL";
    STATE.range = DEFAULT_RANGE;

    buildRangeOptions();
    await ensurePoolForRange(STATE.range);

    refreshLinkedOptions(true);
    STATE.results = sortByPubDesc(STATE.pool.slice());
    renderResults(STATE.results);
  }

  // ---------- Init ----------
  async function main() {
    initTheme();

    buildRangeOptions();
    buildUI();

    await loadIndexAndLatest();
    await ensurePoolForRange(STATE.range);

    // initial options from pool
    refreshLinkedOptions(true);

    // initial render: show latest, but keep a calm default display limit
    STATE.results = sortByPubDesc(STATE.pool.slice());
    renderResults(STATE.results);

    // Wire initial values
    const qEl = qs("#q");
    if (qEl) qEl.value = "";

    // If your index.html has a "display limit" select, respect it
    const selLimit = qs("#selLimit");
    if (selLimit) {
      selLimit.addEventListener("change", () => {
        const v = parseInt(selLimit.value, 10);
        STATE.displayLimit = Number.isFinite(v) ? v : 30;
        renderResults(STATE.results);
      });
      // default
      const v = parseInt(selLimit.value, 10);
      if (Number.isFinite(v)) STATE.displayLimit = v;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    main().catch((e) => {
      console.error(e);
      toast("起動でエラー出たわ（console見てな）");
    });
  });
})();
