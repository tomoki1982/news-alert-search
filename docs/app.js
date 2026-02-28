// docs/app.js
// ニュース検索（RSS複数ソース）
// ルール: スペース=AND, | =OR
// 例: "中国 輸出|規制" -> (中国 AND 輸出) OR 規制

let NEWS = [];
let LAST_FETCHED_AT = null;

const RANGE_OPTIONS = [
  { label: "直近7日", days: 7 },
  { label: "直近30日", days: 30 },
  { label: "直近180日", days: 180 },
  { label: "直近1年", days: 365 },
  { label: "全期間", days: null },
];

// ここにRSSを増やしていく
const SOURCES = [
  // 例：JETRO（※実URLはあなたの環境に合わせて増減OK）
  { name: "JETRO", url: "https://www.jetro.go.jp/rss/news.xml" },
  // 他も足すならここに追加
  // { name: "NHK", url: "https://www3.nhk.or.jp/rss/news/cat0.xml" },
];

function qs(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// HTML属性用（onclickに埋めるので最低限）
function escapeAttr(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

/**
 * 軽量表示URLに変換（スマホで重い記事対策）
 * r.jina.ai は「テキスト中心で表示」できるので体感が激速になることが多い
 */
function toLiteUrl(url) {
  const stripped = String(url ?? "").replace(/^https?:\/\//, "");
  return `https://r.jina.ai/http://${stripped}`;
}

function openUrl(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

// --- クエリ処理（スペース=AND, | =OR） ---
function parseQuery(q) {
  const raw = (q || "").trim();
  if (!raw) return [];

  // ORで分割
  const orParts = raw.split("|").map(s => s.trim()).filter(Boolean);

  // ORの各要素は AND条件（スペース区切り）
  return orParts.map(part => {
    const andTokens = part.split(/\s+/).map(s => s.trim()).filter(Boolean);
    return andTokens;
  });
}

function matchQuery(item, queryGroups) {
  if (!queryGroups || queryGroups.length === 0) return true;

  const hay = `${item.title} ${item.description} ${item.category} ${item.source}`.toLowerCase();

  // OR: どれかのグループが成立すればOK
  return queryGroups.some(andTokens => {
    // AND: 全部含む必要あり
    return andTokens.every(t => hay.includes(String(t).toLowerCase()));
  });
}

// --- 日付 ---
function toDateSafe(s) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function withinRange(itemDate, days) {
  if (!days) return true;
  const d = itemDate instanceof Date ? itemDate : toDateSafe(itemDate);
  if (!d) return true;
  const now = new Date();
  const ms = days * 24 * 60 * 60 * 1000;
  return (now - d) <= ms;
}

// --- RSS取得（CORS回避） ---
async function fetchText(url) {
  // allorigins の raw を使う（CORS回避用）
  // ※アクセスできない環境なら、ここをあなたのプロキシに差し替え
  const proxied = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxied, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  return await res.text();
}

function parseRss(xmlText, sourceName) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  const items = Array.from(doc.querySelectorAll("item"));

  return items.map((it) => {
    const title = it.querySelector("title")?.textContent?.trim() || "(no title)";
    const link = it.querySelector("link")?.textContent?.trim() || "";
    const pubDateRaw =
      it.querySelector("pubDate")?.textContent?.trim() ||
      it.querySelector("dc\\:date")?.textContent?.trim() ||
      "";

    const category =
      it.querySelector("category")?.textContent?.trim() ||
      "その他";

    // RSSのdescriptionは短いことが多い
    const description =
      it.querySelector("description")?.textContent?.trim() ||
      "";

    const pubDate = toDateSafe(pubDateRaw);

    return {
      id: `${sourceName}::${link || title}::${pubDate ? pubDate.toISOString() : pubDateRaw}`,
      source: sourceName,
      title,
      link,
      category,
      pubDate,
      pubDateRaw,
      description,
    };
  });
}

async function fetchAllNews() {
  qs("status").textContent = "取得中…";
  const all = [];
  for (const s of SOURCES) {
    try {
      const xml = await fetchText(s.url);
      const parsed = parseRss(xml, s.name);
      all.push(...parsed);
    } catch (e) {
      console.warn("RSS fetch error:", s.name, e);
    }
  }

  // 重複除去（link優先）
  const map = new Map();
  for (const it of all) {
    const key = it.link || it.id;
    if (!map.has(key)) map.set(key, it);
  }

  NEWS = Array.from(map.values())
    .sort((a, b) => {
      const ad = a.pubDate ? a.pubDate.getTime() : 0;
      const bd = b.pubDate ? b.pubDate.getTime() : 0;
      return bd - ad;
    });

  LAST_FETCHED_AT = new Date();
  qs("status").textContent = "OK";
}

// --- UI構築 ---
function buildSelectOptions(selectEl, values, allLabel) {
  const current = selectEl.value;
  selectEl.innerHTML = "";

  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = allLabel;
  selectEl.appendChild(optAll);

  values.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    selectEl.appendChild(opt);
  });

  // 可能なら元の選択を復元
  selectEl.value = values.includes(current) ? current : "";
}

function initControls() {
  // ソース
  const sourceSel = qs("sourceSelect");
  buildSelectOptions(sourceSel, SOURCES.map(s => s.name), "全ソース");

  // カテゴリ（初期は空。取得後に動的生成）
  const catSel = qs("categorySelect");
  buildSelectOptions(catSel, [], "全カテゴリ");

  // 期間
  const rangeSel = qs("rangeSelect");
  rangeSel.innerHTML = "";
  for (const r of RANGE_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = r.days === null ? "" : String(r.days);
    opt.textContent = r.label;
    rangeSel.appendChild(opt);
  }
  rangeSel.value = "30"; // 直近30日デフォ

  // イベント
  qs("queryInput").addEventListener("input", render);
  sourceSel.addEventListener("change", render);
  catSel.addEventListener("change", render);
  rangeSel.addEventListener("change", render);

  qs("refreshBtn").addEventListener("click", async () => {
    await boot();
  });
}

function updateCategoryOptionsFromNews() {
  const cats = new Set();
  for (const it of NEWS) {
    if (it.category) cats.add(it.category);
  }
  const values = Array.from(cats).sort((a, b) => a.localeCompare(b, "ja"));
  buildSelectOptions(qs("categorySelect"), values, "全カテゴリ");
}

function formatDate(d, raw) {
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return raw ? String(raw).slice(0, 10) : "";
}

function render() {
  const q = qs("queryInput").value;
  const source = qs("sourceSelect").value;     // "" なら全ソース
  const category = qs("categorySelect").value; // "" なら全カテゴリ
  const daysStr = qs("rangeSelect").value;
  const days = daysStr ? Number(daysStr) : null;

  const queryGroups = parseQuery(q);

  const filtered = NEWS.filter(it => {
    if (source && it.source !== source) return false;
    if (category && it.category !== category) return false;
    if (days && !withinRange(it.pubDate ?? it.pubDateRaw, days)) return false;
    if (!matchQuery(it, queryGroups)) return false;
    return true;
  });

  qs("countLabel").textContent = `総件数：${NEWS.length} / ヒット：${filtered.length}`;

  const list = qs("list");
  list.innerHTML = "";

  for (const it of filtered) {
    const card = document.createElement("div");
    card.className = "card";

    const meta = `${escapeHtml(it.source)} / ${escapeHtml(it.category)} / ${escapeHtml(formatDate(it.pubDate, it.pubDateRaw))}`;

    const previewText = it.description
      ? escapeHtml(it.description).slice(0, 220)
      : "（要約なし：このRSSは本文要約を配ってへんみたいやわ）";

    // ★ A：軽量で開く ボタンを追加済み
    card.innerHTML = `
      <div class="meta">${meta}</div>
      <div class="title">${escapeHtml(it.title)}</div>

      <div class="actions">
        <button class="btn" data-act="preview">プレビュー</button>
        <button class="btn link" data-act="open">記事を開く</button>
        <button class="btn btn-lite" data-act="open-lite">軽量で開く</button>
      </div>

      <div class="preview" style="display:none;">
        ${previewText}
        <div class="actions" style="margin-top:10px;">
          <button class="btn" data-act="close">閉じる</button>
          <button class="btn link" data-act="open">記事を開く</button>
          <button class="btn btn-lite" data-act="open-lite">軽量で開く</button>
        </div>
      </div>
    `;

    const preview = card.querySelector(".preview");

    card.querySelector('[data-act="preview"]').addEventListener("click", () => {
      preview.style.display = "block";
    });

    card.querySelector('[data-act="close"]').addEventListener("click", () => {
      preview.style.display = "none";
    });

    card.querySelectorAll('[data-act="open"]').forEach(btn => {
      btn.addEventListener("click", () => {
        if (!it.link) return;
        openUrl(it.link);
      });
    });

    card.querySelectorAll('[data-act="open-lite"]').forEach(btn => {
      btn.addEventListener("click", () => {
        if (!it.link) return;
        openUrl(toLiteUrl(it.link));
      });
    });

    list.appendChild(card);
  }

  // 最終取得時刻
  const ft = qs("fetchedAt");
  if (LAST_FETCHED_AT) {
    ft.textContent = `最終更新：${LAST_FETCHED_AT.toLocaleString("ja-JP")}`;
  } else {
    ft.textContent = "";
  }
}

async function boot() {
  try {
    await fetchAllNews();
    updateCategoryOptionsFromNews();
    render();
  } catch (e) {
    console.error(e);
    qs("status").textContent = "取得失敗";
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initControls();
  await boot();
});
