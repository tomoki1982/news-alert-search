/* =========
   Repo config
   ========= */
const REPO_OWNER  = "tomoki1982";
const REPO_NAME   = "news-alert-search";
const REPO_BRANCH = "main";

/* =========
   App state
   ========= */
const state = {
  index: null,
  latest: [],
  loadedMonths: new Set(), // "YYYY-MM"
  loadedYears: 0,          // 0 = latest only, then 1..5
  allItems: [],            // latest + loaded archive months
};

function qs(id){ return document.getElementById(id); }

function setStatus(msg){
  const el = qs("statusText");
  if (el) el.textContent = msg;
}

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

function parseNdjson(text){
  const out = [];
  const lines = text.split("\n");
  for (const line of lines){
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}

function uniqByLink(items){
  const best = new Map();
  for (const it of items){
    if (!it || !it.link) continue;
    const prev = best.get(it.link);
    if (!prev || (it.pubDate || "") > (prev.pubDate || "")){
      best.set(it.link, it);
    }
  }
  return Array.from(best.values())
    .sort((a,b)=> (b.pubDate||"").localeCompare(a.pubDate||""));
}

function normalizeText(s){
  return (s || "").toLowerCase();
}

function matchKeyword(item, q){
  if (!q) return true;
  const hay =
    `${item.title||""} ${item.source||""} ${item.category||""} ${item.link||""}`.toLowerCase();
  return hay.includes(q);
}

function formatDate(iso){
  if (!iso) return "";
  try{
    const d = new Date(iso);
    const fmt = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year:"numeric", month:"2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit"
    });
    return fmt.format(d);
  }catch{
    return iso;
  }
}

/* =========
   Theme toggle
   ========= */
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

/* =========
   Data fetching
   ========= */
async function fetchText(url){
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.text();
}

async function fetchJson(url){
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.json();
}

function rawArchiveUrl(monthKey){
  const yyyy = monthKey.slice(0,4);
  return `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/archive/${yyyy}/${monthKey}.ndjson.gz`;
}

async function fetchGzipNdjson(monthKey){
  const url = rawArchiveUrl(monthKey);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`archive fetch failed: ${monthKey}`);

  if (!("DecompressionStream" in window)){
    throw new Error("このブラウザはgzip解凍に未対応");
  }

  const ds = new DecompressionStream("gzip");
  const decompressed = res.body.pipeThrough(ds);
  const text = await new Response(decompressed).text();
  return parseNdjson(text);
}

/* =========
   Load index / latest
   ========= */
async function loadIndexAndLatest(){
  setStatus("読み込み中…");
  const [index, latestText] = await Promise.all([
    fetchJson("./data/index.json"),
    fetchText("./data/latest.ndjson"),
  ]);

  state.index = index;
  state.latest = parseNdjson(latestText);
  state.allItems = uniqByLink(state.latest);
  state.loadedMonths.clear();
  state.loadedYears = 0;

  populateFilters(state.allItems);
  render(state.allItems);
  setStatus(`準備OK（最新 ${state.latest.length} 件）`);
}

function populateFilters(items){
  const srcSel = qs("sourceFilter");
  const catSel = qs("categoryFilter");

  const sources = new Set();
  const cats = new Set();
  for (const it of items){
    if (it.source) sources.add(it.source);
    if (it.category) cats.add(it.category);
  }

  srcSel.innerHTML = `<option value="">ソース：すべて</option>`;
  catSel.innerHTML = `<option value="">カテゴリ：すべて</option>`;

  Array.from(sources).sort().forEach(s=>{
    const o = document.createElement("option");
    o.value = s; o.textContent = s;
    srcSel.appendChild(o);
  });

  Array.from(cats).sort().forEach(c=>{
    const o = document.createElement("option");
    o.value = c; o.textContent = c;
    catSel.appendChild(o);
  });
}

/* =========
   Search / render
   ========= */
function applyFilters(){
  const q = normalizeText(qs("q").value.trim());
  const src = qs("sourceFilter").value;
  const cat = qs("categoryFilter").value;

  let items = state.allItems;

  if (src) items = items.filter(it => it.source === src);
  if (cat) items = items.filter(it => it.category === cat);
  if (q) items = items.filter(it => matchKeyword(it, q));

  return items;
}

function render(items){
  qs("summary").textContent =
    `表示 ${items.length} 件（全読み込み ${state.allItems.length} 件）`;

  const list = qs("list");
  list.innerHTML = "";

  for (const it of items){
    const title = escapeHtml(it.title || "");
    const src = escapeHtml(it.source || "");
    const cat = escapeHtml(it.category || "");
    const date = escapeHtml(formatDate(it.pubDate || ""));
    const link = it.link || "";

    // 🔵 Google Web Light 版（案1）
    const liteUrl =
      "https://googleweblight.com/i?u=" + encodeURIComponent(link);

    const card = document.createElement("div");
    card.className = "card";

    card.innerHTML = `
      <div class="card-title">${title}</div>
      <div class="meta">
        <span class="badge">${src}</span>
        ${cat ? `<span class="badge">${cat}</span>` : ""}
        ${date ? `<span>${date}</span>` : ""}
        <a href="${escapeHtml(link)}" target="_blank" rel="noopener">元記事</a>
      </div>
      <div class="actions">
        <a class="btn btn-lite small" href="${escapeHtml(link)}" target="_blank" rel="noopener">
          元記事
        </a>
        <a class="btn small" href="${escapeHtml(liteUrl)}" target="_blank" rel="noopener">
          軽量表示
        </a>
        <button class="btn small" type="button" data-copy="${escapeHtml(link)}">
          URLコピー
        </button>
      </div>
    `;

    list.appendChild(card);
  }

  list.querySelectorAll("button[data-copy]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const url = btn.getAttribute("data-copy") || "";
      try{
        await navigator.clipboard.writeText(url);
        setStatus("URLコピーしたで");
      }catch{
        setStatus("コピー失敗");
      }
    });
  });
}

/* =========
   Events
   ========= */
function resetUI(){
  qs("q").value = "";
  qs("sourceFilter").value = "";
  qs("categoryFilter").value = "";
}

async function main(){
  qs("searchBtn").addEventListener("click", ()=>{
    render(applyFilters());
  });

  qs("resetBtn").addEventListener("click", ()=>{
    resetUI();
    render(state.allItems);
  });

  qs("q").addEventListener("keydown", (e)=>{
    if (e.key === "Enter"){
      render(applyFilters());
    }
  });

  qs("sourceFilter").addEventListener("change", ()=>{
    render(applyFilters());
  });

  qs("categoryFilter").addEventListener("change", ()=>{
    render(applyFilters());
  });

  await loadIndexAndLatest();
}

main().catch(e=>{
  console.error(e);
  setStatus(`エラー：${e.message}`);
});
