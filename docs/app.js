/* =========
   Repo config (IMPORTANT)
   =========
   archive は GitHub Pages では配信されないので、
   raw.githubusercontent.com から取得する。

   ここを自分のリポジトリに合わせて変更してな：
*/
const REPO_OWNER = "tomoki1982";
const REPO_NAME  = "news-alert-search";
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
  filtered: [],
};

function qs(id){ return document.getElementById(id); }

function setStatus(msg){ qs("statusText").textContent = msg; }

function escapeHtml(s){
  return String(s)
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
  return Array.from(best.values()).sort((a,b)=> (b.pubDate||"").localeCompare(a.pubDate||""));
}

function normalizeText(s){ return (s || "").toLowerCase(); }

function matchKeyword(item, q){
  if (!q) return true;
  const hay =
    `${item.title||""} ${item.source||""} ${item.category||""} ${item.link||""}`.toLowerCase();
  return hay.includes(q);
}

function formatDate(iso){
  if (!iso) return "";
  // show YYYY-MM-DD HH:mm (JST)
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
  const key = "theme"; // "light" | "dark" | null
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
  // Use DecompressionStream('gzip') (Chrome/Edge/Android modern OK)
  const url = rawArchiveUrl(monthKey);
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`archive fetch failed: ${monthKey} (${res.status})`);

  if (!("DecompressionStream" in window)) {
    throw new Error("このブラウザはgzip解凍（DecompressionStream）に対応してへん");
  }

  const ds = new DecompressionStream("gzip");
  const decompressed = res.body.pipeThrough(ds);
  const text = await new Response(decompressed).text();
  return parseNdjson(text);
}

/* =========
   Index / latest load
   ========= */
async function loadIndexAndLatest(){
  setStatus("index.json / latest.ndjson 読み込み中…");
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
  render(state.allItems, "直近3か月");
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

  // reset options (keep first)
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
   Range expansion logic
   ========= */
function monthsForLastNYears(n){
  // compute months from index.months that are within last n years from now (JST)
  const months = state.index?.months || [];
  if (!months.length) return [];

  const now = new Date();
  const nowJST = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const cutoff = new Date(nowJST);
  cutoff.setFullYear(cutoff.getFullYear() - n);

  // cutoffMonthKey = YYYY-MM in JST
  const cy = cutoff.getFullYear();
  const cm = cutoff.getMonth() + 1;
  const cutoffKey = `${cy}-${String(cm).padStart(2,"0")}`;

  // months sorted asc; take those >= cutoffKey
  return months.filter(m => m >= cutoffKey);
}

async function expandToYears(n){
  if (!state.index) return;
  if (n <= state.loadedYears) return;

  const needMonths = monthsForLastNYears(n);
  // exclude those already loaded OR included in latest (we treat latest as already in allItems)
  const toLoad = needMonths.filter(m => !state.loadedMonths.has(m));

  if (!toLoad.length){
    state.loadedYears = n;
    return;
  }

  setStatus(`過去ロード中…（直近${n}年 / ${toLoad.length}ヶ月分）`);

  const newly = [];
  // load sequentially to avoid spiky memory/network
  for (let i=0; i<toLoad.length; i++){
    const mk = toLoad[i];
    try{
      const arr = await fetchGzipNdjson(mk);
      newly.push(...arr);
      state.loadedMonths.add(mk);
      setStatus(`過去ロード中…（直近${n}年：${i+1}/${toLoad.length}ヶ月）`);
    }catch(e){
      // continue, but show warning in status
      setStatus(`注意：${mk} の読み込み失敗（継続中）`);
      // small delay so user can see it
      await new Promise(r=>setTimeout(r, 250));
    }
  }

  state.loadedYears = n;
  state.allItems = uniqByLink([...state.allItems, ...newly]);

  populateFilters(state.allItems);
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

function rangeLabel(){
  if (state.loadedYears <= 0) return "直近3か月";
  return `直近${state.loadedYears}年`;
}

function render(items, label){
  qs("rangeLabel").textContent = label;
  qs("summary").textContent = `表示 ${items.length} 件（全読み込み ${state.allItems.length} 件）`;

  const list = qs("list");
  list.innerHTML = "";

  for (const it of items){
    const card = document.createElement("div");
    card.className = "card";

    const title = escapeHtml(it.title || "");
    const src = escapeHtml(it.source || "");
    const cat = escapeHtml(it.category || "");
    const date = escapeHtml(formatDate(it.pubDate || ""));
    const link = it.link || "";

    const openUrl = link;
    // lightweight open: use jina.ai proxy (fast text view)
    const liteUrl = link.startsWith("https://")
      ? `https://r.jina.ai/${link}`
      : (link.startsWith("http://") ? `https://r.jina.ai/http://${link.slice(7)}` : link);

    card.innerHTML = `
      <div class="card-title">${title}</div>
      <div class="meta">
        <span class="badge">${src || "source"}</span>
        ${cat ? `<span class="badge">${cat}</span>` : ""}
        ${date ? `<span>${date}</span>` : ""}
        <a href="${escapeHtml(openUrl)}" target="_blank" rel="noopener">記事を開く</a>
      </div>
      <div class="actions">
        <a class="btn btn-lite small" href="${escapeHtml(openUrl)}" target="_blank" rel="noopener">記事を開く</a>
        <a class="btn small" href="${escapeHtml(liteUrl)}" target="_blank" rel="noopener">軽量で開く</a>
        <button class="btn small" type="button" data-copy="${escapeHtml(openUrl)}">URLコピー</button>
      </div>
    `;

    list.appendChild(card);
  }

  // copy handlers
  list.querySelectorAll("button[data-copy]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const url = btn.getAttribute("data-copy") || "";
      try{
        await navigator.clipboard.writeText(url);
        setStatus("URLコピーしたで");
      }catch{
        setStatus("コピー失敗（ブラウザ制限の可能性）");
      }
    });
  });
}

/* =========
   UI events
   ========= */
function updateExpandButton(){
  const btn = qs("expandBtn");
  const next = Math.min((state.loadedYears || 0) + 1, 5);
  if (state.loadedYears >= 5){
    btn.disabled = true;
    btn.textContent = "過去も探す（最大5年）";
  }else{
    btn.disabled = false;
    btn.textContent = `過去も探す（直近${next}年）`;
  }
}

async function doSearch(){
  const items = applyFilters();
  render(items, rangeLabel());
  updateExpandButton();
}

async function onExpand(){
  const next = Math.min((state.loadedYears || 0) + 1, 5);
  await expandToYears(next);
  await doSearch();
  setStatus(`準備OK（${rangeLabel()}）`);
}

function resetUI(){
  qs("q").value = "";
  qs("sourceFilter").value = "";
  qs("categoryFilter").value = "";
}

async function main(){
  // Guard for repo settings
  if (REPO_OWNER === "YOUR_GITHUB_OWNER" || REPO_NAME === "YOUR_REPO_NAME"){
    setStatus("app.js の REPO_OWNER / REPO_NAME を自分の値に変更してな");
  }

  qs("searchBtn").addEventListener("click", doSearch);
  qs("resetBtn").addEventListener("click", async ()=>{
    resetUI();
    await doSearch();
  });

  qs("q").addEventListener("keydown", (e)=>{
    if (e.key === "Enter") doSearch();
  });

  qs("sourceFilter").addEventListener("change", doSearch);
  qs("categoryFilter").addEventListener("change", doSearch);

  qs("expandBtn").addEventListener("click", onExpand);

  await loadIndexAndLatest();
  updateExpandButton();
}

main().catch(e=>{
  console.error(e);
  setStatus(`エラー：${e.message || e}`);
});
