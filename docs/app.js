/* docs/app.js
   News Finder (GitHub Pages)
   - Load docs/data/latest.ndjson (latest 3 months)
   - Expand search to archive up to 5 years (on demand)
   - AND/OR search: space = AND, OR tokens: | / ｜ / OR
   - Source/Category linked filters (improvement #1)
   - URLまとめてコピー
   - RSS追加メモ（localStorage）: 追加/一覧/削除/JSON出力（sources.json用）
*/

const PATHS = {
  index: "./data/index.json",
  latest: "./data/latest.ndjson",
  metrics: "./data/feed_metrics.json", // optional
  archiveTemplate: "../archive/{YYYY}/{YYYY-MM}.ndjson.gz",
};

const DEFAULT_RANGE = "3m"; // 直近3か月
const MAX_YEARS = 5;

const LS_KEYS = {
  theme: "nf_theme",
  rssMemo: "nf_rss_memo",
};

let STATE = {
  index: null,
  latestItems: [],
  allItemsCache: new Map(), // key: "YYYY-MM" -> items[]
  loadedMonths: new Set(),  // months already loaded into expanded pool
  expandedItems: [],        // merged items from archive when expanded
  currentPool: [],          // currently searchable pool (latest or expanded)
  lastFiltered: [],
  sources: [],
  categories: [],
  theme: "light",
};

function qs(sel, root = document) {
  return root.querySelector(sel);
}
function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function safeText(v) {
  return (v ?? "").toString();
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseISOZ(s) {
  // "2026-02-27T07:10:00Z"
  // fallback for other ISO strings
  try {
    return new Date(s);
  } catch {
    return new Date(0);
  }
}

function formatJstLike(pubDateIso) {
  const d = parseISOZ(pubDateIso);
  if (Number.isNaN(d.getTime())) return "";
  // Show as YYYY/MM/DD HH:MM (local time)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

function monthKeyFromISO(pubDateIso) {
  const d = parseISOZ(pubDateIso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getRangeMonths(rangeValue) {
  // 3m / 1y / 2y / 3y / 4y / 5y
  if (!rangeValue) return 3;
  if (rangeValue === "3m") return 3;
  if (rangeValue.endsWith("y")) {
    const n = parseInt(rangeValue.replace("y", ""), 10);
    if (!Number.isFinite(n)) return 3;
    return Math.min(Math.max(n, 1), MAX_YEARS) * 12;
  }
  return 3;
}

/** ===== Search parsing =====
  - AND: space (half/full width)
  - OR: | / ｜ / OR button inserts " | "
  We treat input as OR groups separated by OR token, each group is AND terms split by spaces.
*/
function normalizeQuery(raw) {
  let s = safeText(raw).trim();
  // normalize full-width spaces to half
  s = s.replace(/\u3000/g, " ");
  // normalize various pipes to |
  s = s.replace(/｜/g, "|");
  // allow " OR " as OR separator
  s = s.replace(/\s+OR\s+/gi, " | ");
  // compress spaces around |
  s = s.replace(/\s*\|\s*/g, " | ");
  // collapse multiple spaces
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function parseQueryToGroups(raw) {
  const q = normalizeQuery(raw);
  if (!q) return [];
  const parts = q.split(" | ").map((x) => x.trim()).filter(Boolean);
  // each part: AND terms split by spaces
  const groups = parts.map((p) => p.split(" ").map((t) => t.trim()).filter(Boolean));
  return groups.filter((g) => g.length > 0);
}

function matchItemByGroups(item, groups) {
  if (!groups || groups.length === 0) return true;

  const hay = [
    item.title,
    item.source,
    item.category,
    item.link,
  ].map(safeText).join(" ").toLowerCase();

  // OR groups
  return groups.some((andTerms) => {
    return andTerms.every((term) => {
      const t = term.toLowerCase();
      return hay.includes(t);
    });
  });
}

/** ===== Loaders ===== */
async function fetchText(url, opts = {}) {
  const r = await fetch(url, { cache: "no-store", ...opts });
  if (!r.ok) throw new Error(`fetch failed: ${r.status} ${url}`);
  return await r.text();
}

async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { cache: "no-store", ...opts });
  if (!r.ok) throw new Error(`fetch failed: ${r.status} ${url}`);
  return await r.json();
}

function parseNDJSON(text) {
  const out = [];
  const lines = safeText(text).split("\n");
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // skip
    }
  }
  return out;
}

// Minimal gunzip in browser: rely on DecompressionStream (Chrome/Edge/Android OK)
async function fetchGzNdjson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch failed: ${r.status} ${url}`);
  const buf = await r.arrayBuffer();
  if (!("DecompressionStream" in window)) {
    throw new Error("DecompressionStream not supported in this browser");
  }
  const ds = new DecompressionStream("gzip");
  const stream = new Response(new Blob([buf]).stream().pipeThrough(ds));
  const text = await stream.text();
  return parseNDJSON(text);
}

function buildArchiveUrl(monthKey) {
  const yyyy = monthKey.slice(0, 4);
  return PATHS.archiveTemplate
    .replace("{YYYY}", yyyy)
    .replace("{YYYY-MM}", monthKey);
}

function dedupeByLink(items) {
  const best = new Map(); // link -> item (newest pubDate wins)
  for (const it of items) {
    const link = safeText(it.link);
    if (!link) continue;
    const prev = best.get(link);
    if (!prev) {
      best.set(link, it);
    } else {
      if (safeText(it.pubDate) > safeText(prev.pubDate)) best.set(link, it);
    }
  }
  const arr = Array.from(best.values());
  arr.sort((a, b) => safeText(b.pubDate).localeCompare(safeText(a.pubDate)));
  return arr;
}

async function loadIndex() {
  STATE.index = await fetchJson(PATHS.index);
  return STATE.index;
}

async function loadLatest() {
  const text = await fetchText(PATHS.latest);
  const items = parseNDJSON(text);
  STATE.latestItems = dedupeByLink(items);
  return STATE.latestItems;
}

function setCurrentPool(pool) {
  STATE.currentPool = pool;
  rebuildFacetOptionsFromPool();
}

function rebuildFacetOptionsFromPool() {
  const srcs = [];
  const cats = [];
  for (const it of STATE.currentPool) {
    const s = safeText(it.source).trim();
    const c = safeText(it.category).trim();
    if (s) srcs.push(s);
    if (c) cats.push(c);
  }
  STATE.sources = uniq(srcs).sort((a, b) => a.localeCompare(b, "ja"));
  STATE.categories = uniq(cats).sort((a, b) => a.localeCompare(b, "ja"));
}

/** ===== Filter linkage (improvement #1) =====
  - Source options depend on selected category
  - Category options depend on selected source
*/
function computeLinkedOptions(pool, selectedSource, selectedCategory) {
  const sourcesSet = new Set();
  const categoriesSet = new Set();

  for (const it of pool) {
    const s = safeText(it.source).trim();
    const c = safeText(it.category).trim();

    // For sources: apply selectedCategory filter only
    if (!selectedCategory || selectedCategory === "__all__") {
      if (s) sourcesSet.add(s);
    } else {
      if (c === selectedCategory && s) sourcesSet.add(s);
    }

    // For categories: apply selectedSource filter only
    if (!selectedSource || selectedSource === "__all__") {
      if (c) categoriesSet.add(c);
    } else {
      if (s === selectedSource && c) categoriesSet.add(c);
    }
  }

  return {
    sources: Array.from(sourcesSet).sort((a, b) => a.localeCompare(b, "ja")),
    categories: Array.from(categoriesSet).sort((a, b) => a.localeCompare(b, "ja")),
  };
}

/** ===== UI helpers ===== */
function setStatus(msg) {
  const el = qs("#status") || qs("[data-role='status']");
  if (el) el.textContent = msg;
}

function setCount(msg) {
  const el = qs("#count") || qs("[data-role='count']");
  if (el) el.textContent = msg;
}

function ensureRuleLine() {
  const rule = qs("#rule") || qs("[data-role='rule']");
  if (!rule) return;
  rule.textContent =
    "ルール：スペース（全角/半角）=AND、ORボタン または「|」「｜」=OR（例： 中国 輸出規制 | 半導体）";
}

function setSelectOptions(selectEl, options, allLabel) {
  if (!selectEl) return;
  const current = selectEl.value;
  const allValue = "__all__";
  const html = [
    `<option value="${allValue}">${allLabel}</option>`,
    ...options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`),
  ].join("");
  selectEl.innerHTML = html;

  // restore if possible
  if (current && (current === allValue || options.includes(current))) {
    selectEl.value = current;
  } else {
    selectEl.value = allValue;
  }
}

function escapeHtml(s) {
  return safeText(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(msg) {
  const el = qs("#toast") || qs("[data-role='toast']");
  if (el) {
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 1600);
    return;
  }
  // fallback
  console.log(msg);
}

function openUrlInNewTab(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

async function copyToClipboard(text) {
  const t = safeText(text);
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    toast("コピーしたで");
  } catch {
    // fallback
    const ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("コピーしたで");
  }
}

/** ===== Rendering ===== */
function renderList(items) {
  const box = qs("#results") || qs("[data-role='results']");
  if (!box) return;

  const maxShow = 30;
  const shown = items.slice(0, maxShow);

  setCount(`表示 ${shown.length} 件（全読み込み ${items.length} 件）`);

  const html = shown
    .map((it) => {
      const title = escapeHtml(it.title || "");
      const source = escapeHtml(it.source || "");
      const category = escapeHtml(it.category || "");
      const dt = escapeHtml(formatJstLike(it.pubDate || ""));
      const link = escapeHtml(it.link || "");
      return `
      <div class="card" data-link="${link}">
        <div class="title">${title}</div>
        <div class="meta">
          <span class="pill">${source || "?"}</span>
          ${category ? `<span class="pill pill-lite">${category}</span>` : ""}
          ${dt ? `<span class="dt">${dt}</span>` : ""}
          <a class="inline-link" href="${link}" target="_blank" rel="noopener noreferrer">記事を開く</a>
        </div>
        <div class="actions">
          <button class="btn btn-primary" data-act="open" data-url="${link}">元記事を開く</button>
          <button class="btn" data-act="copy" data-url="${link}">URLコピー</button>
        </div>
      </div>`;
    })
    .join("");

  box.innerHTML = html;

  // bind buttons
  qsa("[data-act='open']", box).forEach((b) => {
    b.addEventListener("click", () => openUrlInNewTab(b.getAttribute("data-url")));
  });
  qsa("[data-act='copy']", box).forEach((b) => {
    b.addEventListener("click", () => copyToClipboard(b.getAttribute("data-url")));
  });

  // card tap opens
  qsa(".card", box).forEach((c) => {
    c.addEventListener("click", (ev) => {
      const act = ev.target?.getAttribute?.("data-act");
      if (act) return; // buttons handle themselves
      const url = c.getAttribute("data-link");
      if (url) openUrlInNewTab(url);
    });
  });
}

function applyFiltersAndRender() {
  const qEl = qs("#q") || qs("#query") || qs("input[type='text']");
  const srcEl = qs("#source") || qs("#sourceSel") || qs("select[name='source']");
  const catEl = qs("#category") || qs("#categorySel") || qs("select[name='category']");
  const rangeEl = qs("#range") || qs("#rangeSel") || qs("select[name='range']");

  const query = safeText(qEl?.value);
  const selectedSource = safeText(srcEl?.value || "__all__");
  const selectedCategory = safeText(catEl?.value || "__all__");

  const groups = parseQueryToGroups(query);

  const filtered = STATE.currentPool.filter((it) => {
    if (selectedSource !== "__all__" && safeText(it.source) !== selectedSource) return false;
    if (selectedCategory !== "__all__" && safeText(it.category) !== selectedCategory) return false;
    return matchItemByGroups(it, groups);
  });

  STATE.lastFiltered = filtered;
  renderList(filtered);

  // keep linked options fresh
  const linked = computeLinkedOptions(STATE.currentPool, selectedSource, selectedCategory);
  // Rebuild options based on *the other* selection
  // but we need to call with current values to keep consistent:
  setSelectOptions(srcEl, linked.sources, "ソース：すべて");
  setSelectOptions(catEl, linked.categories, "カテゴリ：すべて");

  // range label in status
  const r = safeText(rangeEl?.value || DEFAULT_RANGE);
  const label = rangeLabel(r);
  setStatus(`準備OK（最新 ${STATE.latestItems.length} 件） / 検索範囲：${label}`);
}

function rangeLabel(v) {
  if (v === "3m") return "直近3か月（標準）";
  if (v === "1y") return "直近1年";
  if (v === "2y") return "直近2年";
  if (v === "3y") return "直近3年";
  if (v === "4y") return "直近4年";
  if (v === "5y") return "直近5年";
  return "直近3か月（標準）";
}

function ensureRangeOptions() {
  const rangeEl = qs("#range") || qs("#rangeSel") || qs("select[name='range']");
  if (!rangeEl) return;
  // If already populated, keep
  if (rangeEl.options && rangeEl.options.length >= 3) return;

  const opts = [
    { v: "3m", t: "検索範囲：直近3か月（標準）" },
    { v: "1y", t: "検索範囲：直近1年" },
    { v: "2y", t: "検索範囲：直近2年" },
    { v: "3y", t: "検索範囲：直近3年" },
    { v: "4y", t: "検索範囲：直近4年" },
    { v: "5y", t: "検索範囲：直近5年" },
  ];
  rangeEl.innerHTML = opts.map(o => `<option value="${o.v}">${o.t}</option>`).join("");
  rangeEl.value = DEFAULT_RANGE;
}

/** ===== Expand pool (load archive months) ===== */
async function ensurePoolByRange(rangeValue) {
  const monthsNeeded = getRangeMonths(rangeValue);
  // If 3m => latest only
  if (monthsNeeded <= 3) {
    setCurrentPool(STATE.latestItems);
    return;
  }

  if (!STATE.index?.months?.length) {
    setCurrentPool(STATE.latestItems);
    return;
  }

  // months list in index is ascending; we want last N months up to range
  const allMonths = STATE.index.months.slice(); // ascending
  const target = allMonths.slice(-monthsNeeded); // last N months
  const targetSet = new Set(target);

  // Load missing months
  const toLoad = target.filter((m) => !STATE.loadedMonths.has(m));
  if (toLoad.length === 0) {
    // already loaded, just rebuild pool from cache
    const merged = mergeExpandedFromTarget(targetSet);
    setCurrentPool(merged);
    return;
  }

  setStatus("過去データ読み込み中…（最初だけ少し待ってな）");

  for (const mk of toLoad) {
    const url = buildArchiveUrl(mk);
    try {
      const items = await fetchGzNdjson(url);
      STATE.allItemsCache.set(mk, items);
      STATE.loadedMonths.add(mk);
      // gentle pacing
      await sleep(60);
    } catch (e) {
      console.warn("archive load failed", mk, e);
      // mark as loaded to avoid retry storm (optional)
      STATE.loadedMonths.add(mk);
    }
  }

  const merged = mergeExpandedFromTarget(targetSet);
  setCurrentPool(merged);

  setStatus(`準備OK（最新 ${STATE.latestItems.length} 件） / 検索範囲：${rangeLabel(rangeValue)}`);
}

function mergeExpandedFromTarget(targetSet) {
  const merged = [];
  for (const [mk, items] of STATE.allItemsCache.entries()) {
    if (!targetSet.has(mk)) continue;
    merged.push(...items);
  }
  // Also include latest in case archive missing
  merged.push(...STATE.latestItems);
  return dedupeByLink(merged);
}

/** ===== URLまとめてコピー ===== */
async function copyFilteredUrls() {
  const list = STATE.lastFiltered?.length ? STATE.lastFiltered : [];
  if (list.length === 0) {
    toast("コピーするURLが無いで");
    return;
  }
  const urls = list.map((it) => safeText(it.link)).filter(Boolean);
  await copyToClipboard(urls.join("\n"));
}

/** ===== Theme ===== */
function applyTheme(theme) {
  STATE.theme = theme;
  document.documentElement.dataset.theme = theme; // CSS側で使える
  try {
    localStorage.setItem(LS_KEYS.theme, theme);
  } catch {}
}

function toggleTheme() {
  applyTheme(STATE.theme === "dark" ? "light" : "dark");
}

/** ===== AND / OR helper buttons ===== */
function insertToQuery(token) {
  const qEl = qs("#q") || qs("#query") || qs("input[type='text']");
  if (!qEl) return;
  const start = qEl.selectionStart ?? qEl.value.length;
  const end = qEl.selectionEnd ?? qEl.value.length;
  const before = qEl.value.slice(0, start);
  const after = qEl.value.slice(end);

  const insert = token;
  qEl.value = before + insert + after;

  const pos = (before + insert).length;
  qEl.focus();
  try {
    qEl.setSelectionRange(pos, pos);
  } catch {}
}

function wireAndOrButtons() {
  const andBtn = qs("#btnAnd") || qs("[data-act='and']");
  const orBtn = qs("#btnOr") || qs("[data-act='or']");
  if (andBtn) andBtn.addEventListener("click", () => insertToQuery(" "));
  if (orBtn) orBtn.addEventListener("click", () => insertToQuery(" | "));
}

/** ===== RSS Memo (localStorage) =====
  UI:
    - button next to theme toggle
    - panel modal with form:
        name, url, category
      list:
        each item has copy(JSON line), delete
      export:
        - copy as JSON array for sources.json
*/
function loadRssMemo() {
  try {
    const raw = localStorage.getItem(LS_KEYS.rssMemo);
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) return arr;
    return [];
  } catch {
    return [];
  }
}

function saveRssMemo(arr) {
  try {
    localStorage.setItem(LS_KEYS.rssMemo, JSON.stringify(arr, null, 2));
  } catch {}
}

function slugId(name, url) {
  const base = (name || url || "rss")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const tail = Math.random().toString(36).slice(2, 6);
  return `${base || "rss"}-${tail}`;
}

function ensureRssMemoButton() {
  // Prefer explicit container if exists
  const themeBtn =
    qs("#themeToggle") ||
    qs("#toggleTheme") ||
    qs("[data-act='theme']");
  const headerRight =
    qs("#headerRight") ||
    qs("[data-role='header-right']") ||
    (themeBtn ? themeBtn.parentElement : null) ||
    qs("header") ||
    document.body;

  // Create button if not exist
  if (qs("#btnRssMemo")) return;

  const btn = document.createElement("button");
  btn.id = "btnRssMemo";
  btn.type = "button";
  btn.className = "btn btn-lite";
  btn.textContent = "RSS追加メモ";

  // place next to theme toggle if possible
  if (themeBtn && themeBtn.parentElement) {
    themeBtn.parentElement.insertBefore(btn, themeBtn.nextSibling);
  } else {
    headerRight.appendChild(btn);
  }

  btn.addEventListener("click", openRssMemoPanel);
}

function ensureRssMemoPanel() {
  if (qs("#rssMemoModal")) return;

  const modal = document.createElement("div");
  modal.id = "rssMemoModal";
  modal.style.display = "none";
  modal.innerHTML = `
    <div class="modal-backdrop" data-act="close"></div>
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">RSS追加メモ</div>
        <button class="btn btn-lite" data-act="close">閉じる</button>
      </div>

      <div class="modal-body">
        <div class="hint">
          ここは<strong>メモ</strong>やで（収集に反映するには、コピーした内容を <code>config/sources.json</code> に貼る必要がある）。
        </div>

        <div class="form">
          <div class="row">
            <label>名前</label>
            <input id="memoName" type="text" placeholder="例：中小企業庁" />
          </div>
          <div class="row">
            <label>URL</label>
            <input id="memoUrl" type="text" placeholder="https://.../rss.xml" />
          </div>
          <div class="row">
            <label>カテゴリ</label>
            <input id="memoCategory" type="text" placeholder="例：公的 / 倒産 / 速報" />
          </div>

          <div class="row actions">
            <button class="btn btn-primary" id="memoAdd">メモに追加</button>
            <button class="btn" id="memoCopyAll">sources.json用にまとめてコピー</button>
          </div>
        </div>

        <div class="divider"></div>

        <div class="memo-list">
          <div class="memo-list-head">
            <div>メモ一覧</div>
            <button class="btn btn-lite" id="memoClearAll">全削除</button>
          </div>
          <div id="memoItems"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // close handlers
  qsa("[data-act='close']", modal).forEach((x) => x.addEventListener("click", closeRssMemoPanel));

  // action buttons
  qs("#memoAdd", modal).addEventListener("click", onMemoAdd);
  qs("#memoCopyAll", modal).addEventListener("click", onMemoCopyAll);
  qs("#memoClearAll", modal).addEventListener("click", onMemoClearAll);
}

function openRssMemoPanel() {
  ensureRssMemoPanel();
  refreshRssMemoList();
  const modal = qs("#rssMemoModal");
  modal.style.display = "block";
}

function closeRssMemoPanel() {
  const modal = qs("#rssMemoModal");
  if (modal) modal.style.display = "none";
}

function onMemoAdd() {
  const name = safeText(qs("#memoName")?.value).trim();
  const url = safeText(qs("#memoUrl")?.value).trim();
  const category = safeText(qs("#memoCategory")?.value).trim();

  if (!url) {
    toast("URLは必須やで");
    return;
  }

  const memos = loadRssMemo();

  // prevent exact duplicate url
  if (memos.some((m) => safeText(m.url) === url)) {
    toast("同じURLはもう入ってるで");
    return;
  }

  memos.unshift({
    id: slugId(name, url),
    name: name || url,
    url,
    category: category || "",
    createdAt: new Date().toISOString(),
  });

  saveRssMemo(memos);

  // clear inputs
  if (qs("#memoName")) qs("#memoName").value = "";
  if (qs("#memoUrl")) qs("#memoUrl").value = "";
  if (qs("#memoCategory")) qs("#memoCategory").value = "";

  refreshRssMemoList();
  toast("追加したで");
}

function toSourcesJsonArray(memos) {
  // output format aligns with collect.py:
  // [{"id":"...", "name":"...", "url":"...", "enabled": true, "frequency":"hourly", "category":"..."}]
  return memos.map((m) => ({
    id: safeText(m.id) || slugId(m.name, m.url),
    name: safeText(m.name),
    url: safeText(m.url),
    enabled: true,
    frequency: "hourly",
    category: safeText(m.category || ""),
  }));
}

async function onMemoCopyAll() {
  const memos = loadRssMemo();
  if (memos.length === 0) {
    toast("メモが空やで");
    return;
  }
  const payload = toSourcesJsonArray(memos);
  await copyToClipboard(JSON.stringify(payload, null, 2));
}

function onMemoClearAll() {
  if (!confirm("RSSメモを全部消す？")) return;
  saveRssMemo([]);
  refreshRssMemoList();
  toast("全部消したで");
}

function refreshRssMemoList() {
  const box = qs("#memoItems");
  if (!box) return;

  const memos = loadRssMemo();
  if (memos.length === 0) {
    box.innerHTML = `<div class="empty">まだメモが無いで。URLを入れて追加してな。</div>`;
    return;
  }

  box.innerHTML = memos
    .map((m) => {
      const name = escapeHtml(m.name || "");
      const url = escapeHtml(m.url || "");
      const cat = escapeHtml(m.category || "");
      return `
      <div class="memo-item" data-id="${escapeHtml(m.id)}">
        <div class="memo-main">
          <div class="memo-name">${name}</div>
          <div class="memo-url">${url}</div>
          ${cat ? `<div class="memo-cat">${cat}</div>` : ""}
        </div>
        <div class="memo-actions">
          <button class="btn btn-lite" data-act="memo-copy" data-id="${escapeHtml(m.id)}">1件コピー</button>
          <button class="btn" data-act="memo-del" data-id="${escapeHtml(m.id)}">削除</button>
        </div>
      </div>`;
    })
    .join("");

  qsa("[data-act='memo-copy']", box).forEach((b) => {
    b.addEventListener("click", async () => {
      const id = b.getAttribute("data-id");
      const memos2 = loadRssMemo();
      const target = memos2.find((x) => x.id === id);
      if (!target) return;
      const one = toSourcesJsonArray([target])[0];
      await copyToClipboard(JSON.stringify(one, null, 2));
    });
  });

  qsa("[data-act='memo-del']", box).forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-id");
      const memos2 = loadRssMemo().filter((x) => x.id !== id);
      saveRssMemo(memos2);
      refreshRssMemoList();
      toast("消したで");
    });
  });
}

/** ===== Wiring ===== */
function wireControls() {
  const searchBtn = qs("#btnSearch") || qs("[data-act='search']");
  const resetBtn = qs("#btnReset") || qs("[data-act='reset']");
  const copyUrlsBtn = qs("#btnCopyUrls") || qs("[data-act='copy-urls']");
  const themeBtn = qs("#themeToggle") || qs("#toggleTheme") || qs("[data-act='theme']");
  const qEl = qs("#q") || qs("#query") || qs("input[type='text']");
  const srcEl = qs("#source") || qs("#sourceSel") || qs("select[name='source']");
  const catEl = qs("#category") || qs("#categorySel") || qs("select[name='category']");
  const rangeEl = qs("#range") || qs("#rangeSel") || qs("select[name='range']");

  if (searchBtn) {
    searchBtn.addEventListener("click", async () => {
      await ensurePoolByRange(rangeEl?.value || DEFAULT_RANGE);
      applyFiltersAndRender();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      if (qEl) qEl.value = "";
      if (srcEl) srcEl.value = "__all__";
      if (catEl) catEl.value = "__all__";
      if (rangeEl) rangeEl.value = DEFAULT_RANGE;
      await ensurePoolByRange(DEFAULT_RANGE);
      applyFiltersAndRender();
    });
  }

  if (copyUrlsBtn) {
    copyUrlsBtn.addEventListener("click", copyFilteredUrls);
  }

  if (themeBtn) {
    themeBtn.addEventListener("click", toggleTheme);
  }

  // live update for filters to keep linked options nice
  if (srcEl) {
    srcEl.addEventListener("change", () => applyFiltersAndRender());
  }
  if (catEl) {
    catEl.addEventListener("change", () => applyFiltersAndRender());
  }
  if (qEl) {
    qEl.addEventListener("keydown", async (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        await ensurePoolByRange(rangeEl?.value || DEFAULT_RANGE);
        applyFiltersAndRender();
      }
    });
  }

  if (rangeEl) {
    rangeEl.addEventListener("change", async () => {
      await ensurePoolByRange(rangeEl.value || DEFAULT_RANGE);
      applyFiltersAndRender();
    });
  }

  wireAndOrButtons();
  ensureRssMemoButton();
}

function initTheme() {
  let theme = "light";
  try {
    theme = localStorage.getItem(LS_KEYS.theme) || "light";
  } catch {}
  applyTheme(theme === "dark" ? "dark" : "light");
}

/** ===== Boot ===== */
async function main() {
  ensureRuleLine();
  ensureRangeOptions();
  initTheme();
  ensureRssMemoButton();

  setStatus("読み込み中…");

  try {
    await loadIndex();
  } catch (e) {
    console.warn("index load failed", e);
  }

  try {
    await loadLatest();
  } catch (e) {
    setStatus("latest読み込み失敗（Actionsがまだ生成してない可能性）");
    console.error(e);
    setCurrentPool([]);
    wireControls();
    return;
  }

  // default pool is latest (3m)
  setCurrentPool(STATE.latestItems);

  // initial select options
  const srcEl = qs("#source") || qs("#sourceSel") || qs("select[name='source']");
  const catEl = qs("#category") || qs("#categorySel") || qs("select[name='category']");
  setSelectOptions(srcEl, STATE.sources, "ソース：すべて");
  setSelectOptions(catEl, STATE.categories, "カテゴリ：すべて");

  // bind controls
  wireControls();

  // first render
  setStatus(`準備OK（最新 ${STATE.latestItems.length} 件）`);
  STATE.lastFiltered = STATE.currentPool;
  renderList(STATE.currentPool);
}

document.addEventListener("DOMContentLoaded", main);
