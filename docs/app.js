/* docs/app.js
   News Finder (GitHub Pages)
   Fix:
   - Robust DOM binding (works even if ids differ)
   - Always create status/count/results containers if missing
   - Linked filters (improvement #1)
   - URLまとめてコピー
   - RSS追加メモ（localStorage）
*/

const PATHS = {
  index: "./data/index.json",
  latest: "./data/latest.ndjson",
  archiveTemplate: "./archive/{YYYY}/{YYYY-MM}.ndjson.gz",
};

const DEFAULT_RANGE = "3m";
const MAX_YEARS = 5;

const LS_KEYS = {
  theme: "nf_theme",
  rssMemo: "nf_rss_memo",
};

let STATE = {
  index: null,
  latestItems: [],
  allItemsCache: new Map(), // month -> items[]
  loadedMonths: new Set(),
  currentPool: [],
  lastFiltered: [],
  theme: "light",
};

/* ---------- tiny utils ---------- */
const safeText = (v) => (v ?? "").toString();
const uniq = (arr) => Array.from(new Set(arr));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseISO(s) {
  try {
    return new Date(s);
  } catch {
    return new Date(0);
  }
}

function monthKeyFromISO(pubDateIso) {
  const d = parseISO(pubDateIso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function formatLocal(pubDateIso) {
  const d = parseISO(pubDateIso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${day} ${hh}:${mm}`;
}

function escapeHtml(s) {
  return safeText(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* ---------- robust DOM finders / creators ---------- */
function qsAny(selectors, root = document) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function ensureContainers() {
  // We try to locate an existing "panel" area near controls.
  const panel =
    qsAny(
      [
        "#panel",
        ".panel",
        ".controls",
        ".control-panel",
        "[data-role='panel']",
        "main .card",
        "main",
        "body",
      ],
      document
    ) || document.body;

  // Status line
  let status =
    qsAny(
      [
        "#status",
        "#statusLine",
        "#statusText",
        ".status",
        ".status-line",
        "[data-role='status']",
      ],
      document
    );

  if (!status) {
    status = document.createElement("div");
    status.id = "status";
    status.className = "status-line";
    status.style.marginTop = "8px";
    panel.appendChild(status);
  }

  // Count line
  let count =
    qsAny(
      [
        "#count",
        "#countLine",
        "#countText",
        ".count",
        ".count-line",
        "[data-role='count']",
      ],
      document
    );

  if (!count) {
    count = document.createElement("div");
    count.id = "count";
    count.className = "count-line";
    count.style.margin = "10px 0";
    const main = qsAny(["main", "#main", ".main"], document) || document.body;
    // put it under panel if possible, else in main
    (panel.parentElement ? panel.parentElement : main).appendChild(count);
  }

  // Results container
  let results =
    qsAny(
      [
        "#results",
        "#resultList",
        "#list",
        ".results",
        ".result-list",
        "[data-role='results']",
      ],
      document
    );

  if (!results) {
    results = document.createElement("div");
    results.id = "results";
    results.className = "results";
    const main = qsAny(["main", "#main", ".main"], document) || document.body;
    main.appendChild(results);
  }

  // Toast (optional)
  let toast =
    qsAny(["#toast", ".toast", "[data-role='toast']"], document);
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.className = "toast";
    // minimal inline style if your css doesn't define
    toast.style.position = "fixed";
    toast.style.left = "50%";
    toast.style.bottom = "18px";
    toast.style.transform = "translateX(-50%)";
    toast.style.padding = "10px 14px";
    toast.style.borderRadius = "12px";
    toast.style.background = "rgba(0,0,0,.75)";
    toast.style.color = "#fff";
    toast.style.fontSize = "14px";
    toast.style.zIndex = "9999";
    toast.style.opacity = "0";
    toast.style.pointerEvents = "none";
    toast.style.transition = "opacity .2s ease";
    document.body.appendChild(toast);
  }

  return { panel, status, count, results, toast };
}

let DOM = null;

function setStatus(msg) {
  if (!DOM) DOM = ensureContainers();
  DOM.status.textContent = msg;
}

function setCount(msg) {
  if (!DOM) DOM = ensureContainers();
  DOM.count.textContent = msg;
}

function toast(msg) {
  if (!DOM) DOM = ensureContainers();
  DOM.toast.textContent = msg;
  DOM.toast.style.opacity = "1";
  setTimeout(() => (DOM.toast.style.opacity = "0"), 1400);
}

/* ---------- network ---------- */
async function fetchText(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch failed: ${r.status} ${url}`);
  return await r.text();
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store" });
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

async function fetchGzNdjson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch failed: ${r.status} ${url}`);
  const buf = await r.arrayBuffer();

  if (!("DecompressionStream" in window)) {
    throw new Error("DecompressionStream not supported");
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
  const best = new Map();
  for (const it of items) {
    const link = safeText(it.link).trim();
    if (!link) continue;
    const prev = best.get(link);
    if (!prev) best.set(link, it);
    else if (safeText(it.pubDate) > safeText(prev.pubDate)) best.set(link, it);
  }
  const arr = Array.from(best.values());
  arr.sort((a, b) => safeText(b.pubDate).localeCompare(safeText(a.pubDate)));
  return arr;
}

/* ---------- AND/OR query ---------- */
function normalizeQuery(raw) {
  let s = safeText(raw).trim();
  s = s.replace(/\u3000/g, " "); // full-width space -> half
  s = s.replace(/｜/g, "|");
  s = s.replace(/\s+OR\s+/gi, " | ");
  s = s.replace(/\s*\|\s*/g, " | ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function parseQueryToGroups(raw) {
  const q = normalizeQuery(raw);
  if (!q) return [];
  const parts = q.split(" | ").map((x) => x.trim()).filter(Boolean);
  return parts
    .map((p) => p.split(" ").map((t) => t.trim()).filter(Boolean))
    .filter((g) => g.length);
}

function matchItemByGroups(item, groups) {
  if (!groups || !groups.length) return true;
  const hay = [item.title, item.source, item.category, item.link]
    .map(safeText)
    .join(" ")
    .toLowerCase();

  return groups.some((andTerms) =>
    andTerms.every((t) => hay.includes(t.toLowerCase()))
  );
}

/* ---------- linked filters (improvement #1) ---------- */
function computeLinkedOptions(pool, selectedSource, selectedCategory) {
  const sources = new Set();
  const categories = new Set();

  for (const it of pool) {
    const s = safeText(it.source).trim();
    const c = safeText(it.category).trim();

    // sources filtered only by category
    if (!selectedCategory || selectedCategory === "__all__") {
      if (s) sources.add(s);
    } else {
      if (c === selectedCategory && s) sources.add(s);
    }

    // categories filtered only by source
    if (!selectedSource || selectedSource === "__all__") {
      if (c) categories.add(c);
    } else {
      if (s === selectedSource && c) categories.add(c);
    }
  }

  return {
    sources: Array.from(sources).sort((a, b) => a.localeCompare(b, "ja")),
    categories: Array.from(categories).sort((a, b) => a.localeCompare(b, "ja")),
  };
}

function setSelectOptions(selectEl, options, allLabel) {
  if (!selectEl) return;
  const current = selectEl.value;
  const allValue = "__all__";
  const html = [
    `<option value="${allValue}">${escapeHtml(allLabel)}</option>`,
    ...options.map(
      (o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`
    ),
  ].join("");
  selectEl.innerHTML = html;

  if (current && (current === allValue || options.includes(current))) {
    selectEl.value = current;
  } else {
    selectEl.value = allValue;
  }
}

/* ---------- range ---------- */
function getRangeMonths(rangeValue) {
  if (!rangeValue) return 3;
  if (rangeValue === "3m") return 3;
  if (rangeValue.endsWith("y")) {
    const n = parseInt(rangeValue.replace("y", ""), 10);
    if (!Number.isFinite(n)) return 3;
    return Math.min(Math.max(n, 1), MAX_YEARS) * 12;
  }
  return 3;
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

/* ---------- rendering ---------- */
function openUrl(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

async function copyToClipboard(text) {
  const t = safeText(text);
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    toast("コピーしたで");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("コピーしたで");
  }
}

function renderList(items) {
  if (!DOM) DOM = ensureContainers();
  const box = DOM.results;

  const maxShow = 30;
  const shown = items.slice(0, maxShow);
  setCount(`表示 ${shown.length} 件（全読み込み ${items.length} 件）`);

  if (shown.length === 0) {
    box.innerHTML = `<div style="opacity:.7;padding:14px;">該当なし</div>`;
    return;
  }

  const html = shown
    .map((it) => {
      const title = escapeHtml(it.title || "");
      const source = escapeHtml(it.source || "");
      const category = escapeHtml(it.category || "");
      const dt = escapeHtml(formatLocal(it.pubDate || ""));
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

  qsa("[data-act='open']", box).forEach((b) => {
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openUrl(b.getAttribute("data-url"));
    });
  });
  qsa("[data-act='copy']", box).forEach((b) => {
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await copyToClipboard(b.getAttribute("data-url"));
    });
  });

  qsa(".card", box).forEach((c) => {
    c.addEventListener("click", () => {
      const url = c.getAttribute("data-link");
      if (url) openUrl(url);
    });
  });
}

function getControls() {
  const qEl =
    qsAny(["#q", "#query", "input[type='text']"], document);

  const srcEl =
    qsAny(["#source", "#sourceSel", "select[name='source']"], document);

  const catEl =
    qsAny(["#category", "#categorySel", "select[name='category']"], document);

  const rangeEl =
    qsAny(["#range", "#rangeSel", "select[name='range']"], document);

  const searchBtn =
    qsAny(["#btnSearch", "[data-act='search']"], document);

  const resetBtn =
    qsAny(["#btnReset", "[data-act='reset']"], document);

  const copyUrlsBtn =
    qsAny(["#btnCopyUrls", "[data-act='copy-urls']"], document);

  const andBtn =
    qsAny(["#btnAnd", "[data-act='and']"], document);

  const orBtn =
    qsAny(["#btnOr", "[data-act='or']"], document);

  const themeBtn =
    qsAny(["#themeToggle", "#toggleTheme", "[data-act='theme']"], document);

  return { qEl, srcEl, catEl, rangeEl, searchBtn, resetBtn, copyUrlsBtn, andBtn, orBtn, themeBtn };
}

function applyFiltersAndRender() {
  const { qEl, srcEl, catEl } = getControls();
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

  // linked options
  const linked = computeLinkedOptions(STATE.currentPool, selectedSource, selectedCategory);
  setSelectOptions(srcEl, linked.sources, "ソース：すべて");
  setSelectOptions(catEl, linked.categories, "カテゴリ：すべて");
}

async function copyFilteredUrls() {
  const list = STATE.lastFiltered || [];
  if (!list.length) {
    toast("コピーするURLが無いで");
    return;
  }
  const urls = list.map((it) => safeText(it.link)).filter(Boolean);
  await copyToClipboard(urls.join("\n"));
}

/* ---------- pool loading ---------- */
function setCurrentPool(pool) {
  STATE.currentPool = pool;
}

async function ensurePoolByRange(rangeValue) {
  const monthsNeeded = getRangeMonths(rangeValue);
  if (monthsNeeded <= 3) {
    setCurrentPool(STATE.latestItems);
    return;
  }

  if (!STATE.index?.months?.length) {
    setCurrentPool(STATE.latestItems);
    return;
  }

  const allMonths = STATE.index.months.slice(); // ascending
  const target = allMonths.slice(-monthsNeeded);
  const targetSet = new Set(target);

  const toLoad = target.filter((m) => !STATE.loadedMonths.has(m));
  if (toLoad.length) {
    setStatus("過去データ読み込み中…（最初だけ少し待ってな）");
    for (const mk of toLoad) {
      try {
        const url = buildArchiveUrl(mk);
        const items = await fetchGzNdjson(url);
        STATE.allItemsCache.set(mk, items);
      } catch (e) {
        console.warn("archive load failed", mk, e);
      } finally {
        STATE.loadedMonths.add(mk);
      }
      await sleep(60);
    }
  }

  const merged = [];
  for (const [mk, items] of STATE.allItemsCache.entries()) {
    if (targetSet.has(mk)) merged.push(...items);
  }
  merged.push(...STATE.latestItems);
  setCurrentPool(dedupeByLink(merged));
}

/* ---------- theme ---------- */
function applyTheme(theme) {
  STATE.theme = theme;
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(LS_KEYS.theme, theme);
  } catch {}
}

function toggleTheme() {
  applyTheme(STATE.theme === "dark" ? "light" : "dark");
}

function initTheme() {
  let theme = "light";
  try {
    theme = localStorage.getItem(LS_KEYS.theme) || "light";
  } catch {}
  applyTheme(theme === "dark" ? "dark" : "light");
}

/* ---------- AND/OR buttons ---------- */
function insertToQuery(token) {
  const { qEl } = getControls();
  if (!qEl) return;
  const start = qEl.selectionStart ?? qEl.value.length;
  const end = qEl.selectionEnd ?? qEl.value.length;
  const before = qEl.value.slice(0, start);
  const after = qEl.value.slice(end);
  qEl.value = before + token + after;
  const pos = (before + token).length;
  qEl.focus();
  try {
    qEl.setSelectionRange(pos, pos);
  } catch {}
}

/* ---------- RSS memo ---------- */
function loadRssMemo() {
  try {
    const raw = localStorage.getItem(LS_KEYS.rssMemo);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
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

function toSourcesJsonArray(memos) {
  return memos.map((m) => ({
    id: safeText(m.id) || slugId(m.name, m.url),
    name: safeText(m.name),
    url: safeText(m.url),
    enabled: true,
    frequency: "hourly",
    category: safeText(m.category || ""),
  }));
}

function ensureRssMemoPanel() {
  if (document.querySelector("#rssMemoModal")) return;

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
          ここは<strong>メモ</strong>やで（収集に反映するには、コピーした内容を <code>config/sources.json</code> に貼ってな）。
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

  // close
  qsa("[data-act='close']", modal).forEach((x) =>
    x.addEventListener("click", () => (modal.style.display = "none"))
  );

  // add
  modal.querySelector("#memoAdd").addEventListener("click", () => {
    const name = safeText(modal.querySelector("#memoName")?.value).trim();
    const url = safeText(modal.querySelector("#memoUrl")?.value).trim();
    const category = safeText(modal.querySelector("#memoCategory")?.value).trim();
    if (!url) return toast("URLは必須やで");

    const memos = loadRssMemo();
    if (memos.some((m) => safeText(m.url) === url)) return toast("同じURLはもう入ってるで");

    memos.unshift({
      id: slugId(name, url),
      name: name || url,
      url,
      category: category || "",
      createdAt: new Date().toISOString(),
    });
    saveRssMemo(memos);

    modal.querySelector("#memoName").value = "";
    modal.querySelector("#memoUrl").value = "";
    modal.querySelector("#memoCategory").value = "";

    refreshRssMemoList();
    toast("追加したで");
  });

  // copy all
  modal.querySelector("#memoCopyAll").addEventListener("click", async () => {
    const memos = loadRssMemo();
    if (!memos.length) return toast("メモが空やで");
    const payload = toSourcesJsonArray(memos);
    await copyToClipboard(JSON.stringify(payload, null, 2));
  });

  // clear all
  modal.querySelector("#memoClearAll").addEventListener("click", () => {
    if (!confirm("RSSメモを全部消す？")) return;
    saveRssMemo([]);
    refreshRssMemoList();
    toast("全部消したで");
  });
}

function refreshRssMemoList() {
  const modal = document.querySelector("#rssMemoModal");
  if (!modal) return;
  const box = modal.querySelector("#memoItems");
  if (!box) return;

  const memos = loadRssMemo();
  if (!memos.length) {
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

function ensureRssMemoButton() {
  if (document.querySelector("#btnRssMemo")) return;

  // theme button exists in your UI (moon icon)
  const { themeBtn } = getControls();

  const btn = document.createElement("button");
  btn.id = "btnRssMemo";
  btn.type = "button";
  btn.className = "btn btn-lite";
  btn.textContent = "RSS追加メモ";

  if (themeBtn && themeBtn.parentElement) {
    themeBtn.parentElement.insertBefore(btn, themeBtn.nextSibling);
  } else {
    // fallback: header right-ish
    const header = qsAny(["header", ".header", ".topbar", "body"], document) || document.body;
    header.appendChild(btn);
  }

  btn.addEventListener("click", () => {
    ensureRssMemoPanel();
    refreshRssMemoList();
    const modal = document.querySelector("#rssMemoModal");
    modal.style.display = "block";
  });
}

/* ---------- boot wiring ---------- */
function wireControls() {
  const { qEl, srcEl, catEl, rangeEl, searchBtn, resetBtn, copyUrlsBtn, andBtn, orBtn, themeBtn } = getControls();

  // ensure range select has values (if empty in HTML)
  if (rangeEl && rangeEl.options && rangeEl.options.length <= 1) {
    rangeEl.innerHTML = `
      <option value="3m">検索範囲：直近3か月（標準）</option>
      <option value="1y">検索範囲：直近1年</option>
      <option value="2y">検索範囲：直近2年</option>
      <option value="3y">検索範囲：直近3年</option>
      <option value="4y">検索範囲：直近4年</option>
      <option value="5y">検索範囲：直近5年</option>
    `.trim();
  }
  if (rangeEl) rangeEl.value = rangeEl.value || DEFAULT_RANGE;

  if (searchBtn) {
    searchBtn.addEventListener("click", async () => {
      const rv = rangeEl?.value || DEFAULT_RANGE;
      await ensurePoolByRange(rv);
      setStatus(`準備OK（最新 ${STATE.latestItems.length} 件） / 検索範囲：${rangeLabel(rv)}`);
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
      setStatus(`準備OK（最新 ${STATE.latestItems.length} 件） / 検索範囲：${rangeLabel(DEFAULT_RANGE)}`);
      applyFiltersAndRender();
    });
  }

  if (copyUrlsBtn) {
    copyUrlsBtn.addEventListener("click", copyFilteredUrls);
  }

  if (themeBtn) {
    themeBtn.addEventListener("click", toggleTheme);
  }

  if (andBtn) andBtn.addEventListener("click", () => insertToQuery(" "));
  if (orBtn) orBtn.addEventListener("click", () => insertToQuery(" | "));

  if (srcEl) srcEl.addEventListener("change", applyFiltersAndRender);
  if (catEl) catEl.addEventListener("change", applyFiltersAndRender);

  if (rangeEl) {
    rangeEl.addEventListener("change", async () => {
      const rv = rangeEl.value || DEFAULT_RANGE;
      await ensurePoolByRange(rv);
      setStatus(`準備OK（最新 ${STATE.latestItems.length} 件） / 検索範囲：${rangeLabel(rv)}`);
      applyFiltersAndRender();
    });
  }

  if (qEl) {
    qEl.addEventListener("keydown", async (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const rv = rangeEl?.value || DEFAULT_RANGE;
        await ensurePoolByRange(rv);
        setStatus(`準備OK（最新 ${STATE.latestItems.length} 件） / 検索範囲：${rangeLabel(rv)}`);
        applyFiltersAndRender();
      }
    });
  }

  ensureRssMemoButton();
}

/* ---------- main ---------- */
async function main() {
  DOM = ensureContainers();
  initTheme();

  setStatus("読み込み中…");

  try {
    STATE.index = await fetchJson(PATHS.index);
  } catch (e) {
    console.warn("index.json load failed", e);
    // still continue with latest only
  }

  let latestText;
  try {
    latestText = await fetchText(PATHS.latest);
  } catch (e) {
    console.error("latest.ndjson load failed", e);
    setStatus("latest.ndjson が読めへん（生成前 or パス違い）");
    setCurrentPool([]);
    renderList([]);
    wireControls();
    return;
  }

  const latest = parseNDJSON(latestText);
  STATE.latestItems = dedupeByLink(latest);

  // default pool
  setCurrentPool(STATE.latestItems);
  STATE.lastFiltered = STATE.currentPool;

  // initial filter options
  const { srcEl, catEl } = getControls();
  const srcs = uniq(STATE.currentPool.map((x) => safeText(x.source).trim()).filter(Boolean)).sort((a, b) => a.localeCompare(b, "ja"));
  const cats = uniq(STATE.currentPool.map((x) => safeText(x.category).trim()).filter(Boolean)).sort((a, b) => a.localeCompare(b, "ja"));
  setSelectOptions(srcEl, srcs, "ソース：すべて");
  setSelectOptions(catEl, cats, "カテゴリ：すべて");

  setStatus(`準備OK（最新 ${STATE.latestItems.length} 件） / 検索範囲：${rangeLabel(DEFAULT_RANGE)}`);
  renderList(STATE.currentPool);

  wireControls();
}

document.addEventListener("DOMContentLoaded", main);
