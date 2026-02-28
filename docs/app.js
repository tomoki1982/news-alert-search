/* docs/app.js
   News Finder (GitHub Pages)
   - Robust control detection (selects are detected by option text like "ソース", "カテゴリ", "検索範囲")
   - Linked filters (improvement #1)
   - URLまとめてコピー（フィルタ後の結果）
   - RSS追加メモ（localStorageに保存、sources.json用にまとめコピー）
   - 表示件数はデフォルト30（変更できる「表示件数」セレクト追加）
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
  showLimit: 30,
};

/* ---------- utils ---------- */
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

function qs(sel, root = document) {
  return root.querySelector(sel);
}
function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}
function qsAny(selectors, root = document) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/* ---------- UI containers ---------- */
function ensureContainers() {
  const main = qsAny(["main", "#main", ".main"], document) || document.body;

  // status
  let status = qsAny(
    ["#status", ".status", ".status-line", "[data-role='status']"],
    document
  );
  if (!status) {
    status = document.createElement("div");
    status.id = "status";
    status.className = "status-line";
    status.style.margin = "8px 0";
    main.prepend(status);
  }

  // count
  let count = qsAny(
    ["#count", ".count", ".count-line", "[data-role='count']"],
    document
  );
  if (!count) {
    count = document.createElement("div");
    count.id = "count";
    count.className = "count-line";
    count.style.margin = "10px 0";
    main.appendChild(count);
  }

  // results
  let results = qsAny(
    ["#results", ".results", "#resultList", ".result-list", "[data-role='results']"],
    document
  );
  if (!results) {
    results = document.createElement("div");
    results.id = "results";
    results.className = "results";
    main.appendChild(results);
  }

  // toast
  let toast = qsAny(["#toast", ".toast", "[data-role='toast']"], document);
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
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

  return { status, count, results, toast, main };
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

/* ---------- fetch ---------- */
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
    } catch {}
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
  s = s.replace(/\u3000/g, " "); // 全角スペース -> 半角
  s = s.replace(/｜/g, "|");      // 全角パイプ -> 半角
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

/* ---------- control detection (超重要) ---------- */
function detectSelects() {
  const selects = qsa("select");

  const pick = (keyword) => {
    // 1) option text に keyword を含む select を探す
    for (const s of selects) {
      const txt = safeText(s.options?.[0]?.textContent || "");
      const allTxt = Array.from(s.options || [])
        .slice(0, 3)
        .map((o) => safeText(o.textContent))
        .join(" ");
      if (txt.includes(keyword) || allTxt.includes(keyword)) return s;
    }
    // 2) placeholder的に近いlabelを探す（selectの親要素内のテキスト）
    for (const s of selects) {
      const parentText = safeText(s.parentElement?.textContent || "");
      if (parentText.includes(keyword)) return s;
    }
    return null;
  };

  return {
    srcEl: pick("ソース"),
    catEl: pick("カテゴリ"),
    rangeEl: pick("検索範囲"),
  };
}

function detectInputsAndButtons() {
  const qEl =
    qsAny(["#q", "#query", "input[type='text']"], document);

  // ボタンは data-act があれば優先、なければ文言で拾う
  const buttons = qsa("button");

  const pickBtnByActOrText = (act, text) => {
    const byAct = qs(`[data-act='${act}']`);
    if (byAct) return byAct;
    for (const b of buttons) {
      const t = safeText(b.textContent).trim();
      if (t === text) return b;
    }
    return null;
  };

  const searchBtn = pickBtnByActOrText("search", "検索");
  const resetBtn = pickBtnByActOrText("reset", "リセット");
  const copyUrlsBtn = pickBtnByActOrText("copy-urls", "URLまとめてコピー");

  const andBtn = pickBtnByActOrText("and", "AND");
  const orBtn = pickBtnByActOrText("or", "OR");

  // ダークモードは月アイコンボタン(既存)を拾う
  const themeBtn =
    qsAny(["#themeToggle", "#toggleTheme", "[data-act='theme']", ".theme-toggle"], document);

  return { qEl, searchBtn, resetBtn, copyUrlsBtn, andBtn, orBtn, themeBtn };
}

function getControls() {
  const { srcEl, catEl, rangeEl } = detectSelects();
  const { qEl, searchBtn, resetBtn, copyUrlsBtn, andBtn, orBtn, themeBtn } = detectInputsAndButtons();
  return { qEl, srcEl, catEl, rangeEl, searchBtn, resetBtn, copyUrlsBtn, andBtn, orBtn, themeBtn };
}

/* ---------- linked filters (改善案①) ---------- */
function computeLinkedOptions(pool, selectedSource, selectedCategory) {
  const sources = new Set();
  const categories = new Set();

  for (const it of pool) {
    const s = safeText(it.source).trim();
    const c = safeText(it.category).trim();

    // source options depend on category only
    if (!selectedCategory || selectedCategory === "__all__") {
      if (s) sources.add(s);
    } else {
      if (c === selectedCategory && s) sources.add(s);
    }

    // category options depend on source only
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

  selectEl.innerHTML =
    [`<option value="${allValue}">${escapeHtml(allLabel)}</option>`]
      .concat(options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`))
      .join("");

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

function ensureShowLimitSelect() {
  // 既にあるなら何もしない
  if (qs("#showLimit")) return;

  const { rangeEl } = getControls();
  if (!rangeEl || !rangeEl.parentElement) return;

  const wrap = document.createElement("div");
  wrap.style.display = "inline-block";
  wrap.style.marginLeft = "8px";

  wrap.innerHTML = `
    <select id="showLimit" style="min-width: 160px;">
      <option value="30">表示：30件</option>
      <option value="50">表示：50件</option>
      <option value="100">表示：100件</option>
      <option value="999999">表示：すべて</option>
    </select>
  `.trim();

  rangeEl.parentElement.appendChild(wrap);

  const sel = qs("#showLimit");
  sel.value = String(STATE.showLimit);
  sel.addEventListener("change", () => {
    const v = parseInt(sel.value, 10);
    STATE.showLimit = Number.isFinite(v) ? v : 30;
    applyFiltersAndRender();
  });
}

function renderList(items) {
  if (!DOM) DOM = ensureContainers();
  const box = DOM.results;

  const limit = STATE.showLimit || 30;
  const shown = items.slice(0, limit);

  setCount(`表示 ${shown.length} 件（全読み込み ${items.length} 件）`);

  if (shown.length === 0) {
    box.innerHTML = `<div style="opacity:.7;padding:14px;">該当なし</div>`;
    return;
  }

  box.innerHTML = shown
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

  // linked options (source depends on category / category depends on source)
  const linked = computeLinkedOptions(STATE.currentPool, selectedSource, selectedCategory);
  setSelectOptions(srcEl, linked.sources, "ソース：すべて");
  setSelectOptions(catEl, linked.categories, "カテゴリ：すべて");

  renderList(filtered);
}

async function copyFilteredUrls() {
  const list = STATE.lastFiltered || [];
  if (!list.length) return toast("コピーするURLが無いで");
  const urls = list.map((it) => safeText(it.link)).filter(Boolean);
  await copyToClipboard(urls.join("\n"));
}

/* ---------- pool loading ---------- */
async function ensurePoolByRange(rangeValue) {
  const monthsNeeded = getRangeMonths(rangeValue);
  if (monthsNeeded <= 3) {
    STATE.currentPool = STATE.latestItems;
    return;
  }
  if (!STATE.index?.months?.length) {
    STATE.currentPool = STATE.latestItems;
    return;
  }

  const allMonths = STATE.index.months.slice(); // asc
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
  STATE.currentPool = dedupeByLink(merged);
}

/* ---------- theme ---------- */
function applyTheme(theme) {
  STATE.theme = theme;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(LS_KEYS.theme, theme); } catch {}
}
function toggleTheme() {
  applyTheme(STATE.theme === "dark" ? "light" : "dark");
}
function initTheme() {
  let theme = "light";
  try { theme = localStorage.getItem(LS_KEYS.theme) || "light"; } catch {}
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
  try { qEl.setSelectionRange(pos, pos); } catch {}
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
  try { localStorage.setItem(LS_KEYS.rssMemo, JSON.stringify(arr, null, 2)); } catch {}
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

function ensureRssMemoModal() {
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
          ここは<strong>メモ</strong>やで。収集に反映するには、下の「まとめてコピー」を
          <code>config/sources.json</code> に貼ってな。
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
  `.trim();

  document.body.appendChild(modal);

  qsa("[data-act='close']", modal).forEach((x) =>
    x.addEventListener("click", () => (modal.style.display = "none"))
  );

  qs("#memoAdd", modal).addEventListener("click", () => {
    const name = safeText(qs("#memoName", modal)?.value).trim();
    const url = safeText(qs("#memoUrl", modal)?.value).trim();
    const category = safeText(qs("#memoCategory", modal)?.value).trim();
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
    qs("#memoName", modal).value = "";
    qs("#memoUrl", modal).value = "";
    qs("#memoCategory", modal).value = "";
    refreshRssMemoList();
    toast("追加したで");
  });

  qs("#memoCopyAll", modal).addEventListener("click", async () => {
    const memos = loadRssMemo();
    if (!memos.length) return toast("メモが空やで");
    const payload = toSourcesJsonArray(memos);
    await copyToClipboard(JSON.stringify(payload, null, 2));
  });

  qs("#memoClearAll", modal).addEventListener("click", () => {
    if (!confirm("RSSメモを全部消す？")) return;
    saveRssMemo([]);
    refreshRssMemoList();
    toast("全部消したで");
  });
}

function refreshRssMemoList() {
  const modal = qs("#rssMemoModal");
  if (!modal) return;
  const box = qs("#memoItems", modal);
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
      const id = escapeHtml(m.id || "");
      return `
      <div class="memo-item" data-id="${id}">
        <div class="memo-main">
          <div class="memo-name">${name}</div>
          <div class="memo-url">${url}</div>
          ${cat ? `<div class="memo-cat">${cat}</div>` : ""}
        </div>
        <div class="memo-actions">
          <button class="btn btn-lite" data-act="memo-copy" data-id="${id}">1件コピー</button>
          <button class="btn" data-act="memo-del" data-id="${id}">削除</button>
        </div>
      </div>
      `.trim();
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
  // すでにHTML側にあるボタンを優先（テキストで拾う）
  const existing = qsa("button").find((b) => safeText(b.textContent).trim() === "RSS追加メモ");
  if (existing) {
    existing.addEventListener("click", () => {
      ensureRssMemoModal();
      refreshRssMemoList();
      qs("#rssMemoModal").style.display = "block";
    });
    return;
  }

  // なければ作る（テーマボタンの隣）
  const { themeBtn } = getControls();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-lite";
  btn.textContent = "RSS追加メモ";

  if (themeBtn && themeBtn.parentElement) {
    themeBtn.parentElement.insertBefore(btn, themeBtn.nextSibling);
  } else {
    document.body.appendChild(btn);
  }

  btn.addEventListener("click", () => {
    ensureRssMemoModal();
    refreshRssMemoList();
    qs("#rssMemoModal").style.display = "block";
  });
}

/* ---------- wiring ---------- */
function wireControls() {
  const { qEl, srcEl, catEl, rangeEl, searchBtn, resetBtn, copyUrlsBtn, andBtn, orBtn, themeBtn } = getControls();

  // range selectが空なら補完
  if (rangeEl && (!rangeEl.options || rangeEl.options.length <= 1)) {
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

  ensureShowLimitSelect();

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

  if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
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
  }

  let latestText = "";
  try {
    latestText = await fetchText(PATHS.latest);
  } catch (e) {
    console.error("latest.ndjson load failed", e);
    setStatus("latest.ndjson が読めへん（生成前 or パス違い or キャッシュ）");
    STATE.latestItems = [];
    STATE.currentPool = [];
    renderList([]);
    wireControls();
    return;
  }

  const latest = parseNDJSON(latestText);
  STATE.latestItems = dedupeByLink(latest);

  // default pool
  STATE.currentPool = STATE.latestItems;
  STATE.lastFiltered = STATE.currentPool;

  // 初回 options セット
  const { srcEl, catEl } = getControls();
  const srcs = uniq(STATE.currentPool.map((x) => safeText(x.source).trim()).filter(Boolean))
    .sort((a, b) => a.localeCompare(b, "ja"));
  const cats = uniq(STATE.currentPool.map((x) => safeText(x.category).trim()).filter(Boolean))
    .sort((a, b) => a.localeCompare(b, "ja"));

  setSelectOptions(srcEl, srcs, "ソース：すべて");
  setSelectOptions(catEl, cats, "カテゴリ：すべて");

  setStatus(`準備OK（最新 ${STATE.latestItems.length} 件） / 検索範囲：${rangeLabel(DEFAULT_RANGE)}`);

  renderList(STATE.currentPool);
  wireControls();
}

document.addEventListener("DOMContentLoaded", main);
