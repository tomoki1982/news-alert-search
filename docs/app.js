// docs/app.js
// - AND/OR説明はUI側(index.html)に表示
// - 検索範囲: デフォルト直近3か月
// - 直近1〜5年を選ぶと、必要な過去アーカイブ(.ndjson.gz)を追加読み込み
// - カード全体タップで元記事を同一タブで開く（軽量表示は撤去）
// - URLコピーは残す（伝播停止）

const state = {
  latest: [],
  allItems: [],
  loadedArchives: new Set(), // path strings
  archiveIndex: null,        // parsed index.json
};

function qs(id) { return document.getElementById(id); }

function setStatus(msg) {
  const el = qs("statusText");
  if (el) el.textContent = msg;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

function parseNdjson(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}

function uniqByLink(items) {
  const m = new Map();
  for (const it of items) {
    if (!it || !it.link) continue;
    if (!m.has(it.link)) m.set(it.link, it);
  }
  return Array.from(m.values()).sort((a,b) =>
    (b.pubDate || "").localeCompare(a.pubDate || "")
  );
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone:"Asia/Tokyo",
      year:"numeric", month:"2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit"
    }).format(d);
  } catch {
    return iso;
  }
}

function nowJst() {
  // Date自体はUTC基準で保持されるが、差分計算はこれでOK
  return new Date();
}

function cutoffDate(rangeValue) {
  const n = nowJst();
  const d = new Date(n.getTime());
  if (rangeValue === "3m") {
    d.setMonth(d.getMonth() - 3);
  } else if (rangeValue.endsWith("y")) {
    const years = parseInt(rangeValue.slice(0, -1), 10);
    d.setFullYear(d.getFullYear() - years);
  } else {
    d.setMonth(d.getMonth() - 3);
  }
  return d;
}

function inRange(item, rangeValue) {
  const cd = cutoffDate(rangeValue);
  const t = item?.pubDate ? new Date(item.pubDate) : null;
  if (!t || isNaN(t.getTime())) return true; // 日付が無いのは一旦含める
  return t >= cd;
}

function populateFilters(items) {
  const srcSel = qs("sourceFilter");
  const catSel = qs("categoryFilter");
  if (!srcSel || !catSel) return;

  const sources = new Set();
  const cats = new Set();
  for (const it of items) {
    if (it.source) sources.add(it.source);
    if (it.category) cats.add(it.category);
  }

  srcSel.innerHTML = `<option value="">ソース：すべて</option>`;
  catSel.innerHTML = `<option value="">カテゴリ：すべて</option>`;

  Array.from(sources).sort().forEach(s => {
    const o = document.createElement("option");
    o.value = s; o.textContent = s;
    srcSel.appendChild(o);
  });

  Array.from(cats).sort().forEach(c => {
    const o = document.createElement("option");
    o.value = c; o.textContent = c;
    catSel.appendChild(o);
  });
}

function applyFilters() {
  const q = (qs("q")?.value || "").trim().toLowerCase();
  const src = qs("sourceFilter")?.value || "";
  const cat = qs("categoryFilter")?.value || "";
  const range = qs("rangeFilter")?.value || "3m";

  let items = state.allItems;

  // 検索範囲
  items = items.filter(it => inRange(it, range));

  // ソース/カテゴリ
  if (src) items = items.filter(it => it.source === src);
  if (cat) items = items.filter(it => it.category === cat);

  // キーワード
  if (q) {
    items = items.filter(it => {
      const hay = `${it.title||""} ${it.source||""} ${it.category||""} ${it.link||""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  return items;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus("URLコピーしたで");
  } catch {
    setStatus("コピー失敗（ブラウザ設定によるかも）");
  }
}

function openInSameTab(url) {
  if (!url) return;
  location.href = url;
}

function render(items) {
  const summary = qs("summary");
  if (summary) {
    summary.textContent = `表示 ${items.length} 件（全読み込み ${state.allItems.length} 件）`;
  }

  const list = qs("list");
  if (!list) return;
  list.innerHTML = "";

  for (const it of items) {
    const title = escapeHtml(it.title || "");
    const src = escapeHtml(it.source || "");
    const cat = escapeHtml(it.category || "");
    const date = escapeHtml(formatDate(it.pubDate || ""));
    const link = (it.link || "").trim();

    const card = document.createElement("div");
    card.className = "card";

    // カード全体タップで遷移
    card.addEventListener("click", () => openInSameTab(link));

    const openBtn = link
      ? `<button class="btn primary small" type="button" data-open="1">元記事を開く</button>`
      : `<span class="btn primary small" style="opacity:.45;pointer-events:none;">元記事を開く</span>`;

    const copyBtn = link
      ? `<button class="btn small" type="button" data-copy="${escapeHtml(link)}">URLコピー</button>`
      : `<span class="btn small" style="opacity:.45;pointer-events:none;">URLコピー</span>`;

    card.innerHTML = `
      <div class="card-title">${title}</div>
      <div class="meta">
        <span class="badge">${src}</span>
        ${cat ? `<span class="badge">${cat}</span>` : ""}
        ${date ? `<span>${date}</span>` : ""}
        ${link ? `<span class="muted">（カードをタップでも開く）</span>` : ""}
      </div>
      <div class="actions">
        ${openBtn}
        ${copyBtn}
      </div>
    `;

    // ボタンは伝播停止
    const open = card.querySelector('button[data-open="1"]');
    if (open) {
      open.addEventListener("click", (e) => {
        e.stopPropagation();
        openInSameTab(link);
      });
    }
    const copy = card.querySelector("button[data-copy]");
    if (copy) {
      copy.addEventListener("click", (e) => {
        e.stopPropagation();
        const u = copy.getAttribute("data-copy") || "";
        copyText(u);
      });
    }

    list.appendChild(card);
  }
}

/* Theme toggle */
(function(){
  const key = "theme";
  const btn = qs("themeToggle");
  if (!btn) return;

  const apply = (mode) => {
    document.documentElement.dataset.theme = mode || "";
    btn.textContent = (mode === "dark") ? "☀️" : "🌙";
  };

  const saved = localStorage.getItem(key);
  if (saved === "light" || saved === "dark") apply(saved);
  else apply(null);

  btn.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme;
    const next = (cur === "dark") ? "light" : "dark";
    localStorage.setItem(key, next);
    apply(next);
  });
})();

async function fetchText(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return await res.text();
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return await res.json();
}

async function fetchGzipNdjson(path) {
  // gzip対応チェック
  if (typeof DecompressionStream === "undefined") {
    throw new Error("このブラウザはgzip解凍に未対応（DecompressionStreamなし）");
  }
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);

  const ds = new DecompressionStream("gzip");
  const stream = res.body.pipeThrough(ds);
  const text = await new Response(stream).text();
  return parseNdjson(text);
}

function monthKeysForRange(rangeValue) {
  // 例: 直近2年 → 24ヶ月分の YYYY-MM を返す
  const n = nowJst();
  const months = (rangeValue === "3m") ? 3 : (parseInt(rangeValue, 10) * 12);
  const keys = [];
  const d = new Date(n.getTime());
  // 今月も含める（当月-0 〜 当月-(months-1)）
  for (let i = 0; i < months; i++) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    keys.push(`${y}-${m}`);
    d.setMonth(d.getMonth() - 1);
  }
  return keys;
}

function normalizeArchiveIndex(idx) {
  // index.json の形が不明でも吸収する
  // 期待: ["archive/2026/2026-02.ndjson.gz", ...]
  // or { files: [...] } or { items:[{path:"..."}] } etc.
  if (!idx) return [];
  if (Array.isArray(idx)) return idx;

  if (Array.isArray(idx.files)) return idx.files;
  if (Array.isArray(idx.items)) return idx.items.map(x => x.path || x.file || x.url).filter(Boolean);

  // object map { "2026-02": "archive/2026/2026-02.ndjson.gz" }
  const out = [];
  for (const k of Object.keys(idx)) {
    const v = idx[k];
    if (typeof v === "string") out.push(v);
  }
  return out;
}

function pickArchivePathsForRange(allPaths, rangeValue) {
  // monthKey が含まれる path を拾う（YYYY-MM）
  const keys = new Set(monthKeysForRange(rangeValue));
  return allPaths.filter(p => {
    // "2026-02" がパスに含まれる前提
    for (const k of keys) {
      if (p.includes(k)) return true;
    }
    return false;
  });
}

async function ensureArchivesLoadedForRange(rangeValue) {
  // 3mはlatestだけで十分（追加読み込みしない）
  if (rangeValue === "3m") return;

  // index.json を読む（アーカイブ一覧）
  if (!state.archiveIndex) {
    try {
      state.archiveIndex = await fetchJson("./data/index.json");
    } catch (e) {
      // index.json が無い/壊れてる場合でも、アプリ自体は動かす
      console.warn(e);
      setStatus("過去アーカイブの一覧が読めへんかった（index.json）");
      return;
    }
  }

  const allPaths = normalizeArchiveIndex(state.archiveIndex);
  const needPaths = pickArchivePathsForRange(allPaths, rangeValue)
    .filter(p => !state.loadedArchives.has(p));

  if (needPaths.length === 0) return;

  setStatus(`過去データ読み込み中…（追加 ${needPaths.length} ファイル）`);

  // まとめて読み込み（重すぎる場合は分割も可）
  const added = [];
  for (const p of needPaths) {
    try {
      const items = await fetchGzipNdjson(`./${p}`.replace(/^\.\/\.\//, "./"));
      added.push(...items);
      state.loadedArchives.add(p);
    } catch (e) {
      console.warn("archive load failed:", p, e);
      // 失敗しても続行（1個コケても他は読む）
    }
  }

  if (added.length > 0) {
    state.allItems = uniqByLink(state.allItems.concat(added));
    populateFilters(state.allItems);
  }

  setStatus(`準備OK（最新 ${state.latest.length} 件 / 全体 ${state.allItems.length} 件）`);
}

async function loadLatest() {
  setStatus("読み込み中…");
  const text = await fetchText("./data/latest.ndjson");
  state.latest = parseNdjson(text);
  state.allItems = uniqByLink(state.latest);

  populateFilters(state.allItems);
  render(applyFilters());
  setStatus(`準備OK（最新 ${state.latest.length} 件）`);
}

function initEvents() {
  qs("searchBtn")?.addEventListener("click", async () => {
    const range = qs("rangeFilter")?.value || "3m";
    await ensureArchivesLoadedForRange(range);
    render(applyFilters());
  });

  qs("resetBtn")?.addEventListener("click", async () => {
    if (qs("q")) qs("q").value = "";
    if (qs("sourceFilter")) qs("sourceFilter").value = "";
    if (qs("categoryFilter")) qs("categoryFilter").value = "";
    if (qs("rangeFilter")) qs("rangeFilter").value = "3m";
    // resetは即描画（過去読み込みはしない）
    render(applyFilters());
  });

  qs("q")?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const range = qs("rangeFilter")?.value || "3m";
      await ensureArchivesLoadedForRange(range);
      render(applyFilters());
    }
  });

  qs("sourceFilter")?.addEventListener("change", () => render(applyFilters()));
  qs("categoryFilter")?.addEventListener("change", () => render(applyFilters()));

  // 範囲を変えたら見た目を即反映（必要なら検索時に過去を読む）
  qs("rangeFilter")?.addEventListener("change", () => render(applyFilters()));
}

(async function main(){
  try {
    initEvents();
    await loadLatest();
  } catch (e) {
    console.error(e);
    setStatus(`エラー：${e?.message || e}`);
  }
})();
