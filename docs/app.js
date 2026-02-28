// docs/app.js
// - 「軽量表示」ボタン撤去
// - カード全体タップで「元記事」を同一タブで開く（体感速く・操作ミス減）
// - URLコピーはクリックしても遷移しない

const state = {
  latest: [],
  allItems: [],
};

function qs(id) {
  return document.getElementById(id);
}

function setStatus(msg) {
  const el = qs("statusText");
  if (el) el.textContent = msg;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseNdjson(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip broken lines
    }
  }
  return out;
}

function uniqByLink(items) {
  const m = new Map();
  for (const it of items) {
    if (!it || !it.link) continue;
    if (!m.has(it.link)) m.set(it.link, it);
  }
  return Array.from(m.values()).sort((a, b) =>
    (b.pubDate || "").localeCompare(a.pubDate || "")
  );
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return iso;
  }
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

  Array.from(sources)
    .sort()
    .forEach((s) => {
      const o = document.createElement("option");
      o.value = s;
      o.textContent = s;
      srcSel.appendChild(o);
    });

  Array.from(cats)
    .sort()
    .forEach((c) => {
      const o = document.createElement("option");
      o.value = c;
      o.textContent = c;
      catSel.appendChild(o);
    });
}

function applyFilters() {
  const q = (qs("q")?.value || "").trim().toLowerCase();
  const src = qs("sourceFilter")?.value || "";
  const cat = qs("categoryFilter")?.value || "";

  let items = state.allItems;

  if (src) items = items.filter((it) => it.source === src);
  if (cat) items = items.filter((it) => it.category === cat);

  if (q) {
    items = items.filter((it) => {
      const hay = `${it.title || ""} ${it.source || ""} ${it.category || ""} ${it.link || ""}`.toLowerCase();
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
  // 同一タブ遷移（新規タブ生成のオーバーヘッドを避ける）
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
    card.dataset.href = link;

    // カード全体タップで遷移
    card.addEventListener("click", () => {
      openInSameTab(link);
    });

    // ボタン部分だけはクリックがカードに伝播しないようにする
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

    // ボタン操作：伝播停止
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
(function () {
  const key = "theme";
  const btn = qs("themeToggle");
  if (!btn) return;

  const apply = (mode) => {
    document.documentElement.dataset.theme = mode || "";
    btn.textContent = mode === "dark" ? "☀️" : "🌙";
  };

  const saved = localStorage.getItem(key);
  if (saved === "light" || saved === "dark") apply(saved);
  else apply(null);

  btn.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === "dark" ? "light" : "dark";
    localStorage.setItem(key, next);
    apply(next);
  });
})();

async function loadLatest() {
  setStatus("読み込み中…");
  const res = await fetch("./data/latest.ndjson", { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const text = await res.text();

  state.latest = parseNdjson(text);
  state.allItems = uniqByLink(state.latest);

  populateFilters(state.allItems);
  render(state.allItems);
  setStatus(`準備OK（最新 ${state.latest.length} 件）`);
}

function initEvents() {
  const searchBtn = qs("searchBtn");
  const resetBtn = qs("resetBtn");
  const q = qs("q");
  const src = qs("sourceFilter");
  const cat = qs("categoryFilter");

  if (searchBtn) searchBtn.addEventListener("click", () => render(applyFilters()));

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (q) q.value = "";
      if (src) src.value = "";
      if (cat) cat.value = "";
      render(state.allItems);
    });
  }

  if (q) {
    q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") render(applyFilters());
    });
  }

  if (src) src.addEventListener("change", () => render(applyFilters()));
  if (cat) cat.addEventListener("change", () => render(applyFilters()));
}

(async function main() {
  try {
    initEvents();
    await loadLatest();
  } catch (e) {
    console.error(e);
    setStatus(`エラー：${e?.message || e}`);
  }
})();
