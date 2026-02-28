const state = {
  latest: [],
  allItems: [],
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
  for (const line of text.split("\n")){
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}

function uniqByLink(items){
  const m = new Map();
  for (const it of items){
    if (!it || !it.link) continue;
    if (!m.has(it.link)) m.set(it.link, it);
  }
  return Array.from(m.values())
    .sort((a,b)=> (b.pubDate||"").localeCompare(a.pubDate||""));
}

function formatDate(iso){
  if (!iso) return "";
  try{
    const d = new Date(iso);
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone:"Asia/Tokyo",
      year:"numeric", month:"2-digit", day:"2-digit",
      hour:"2-digit", minute:"2-digit"
    }).format(d);
  }catch{ return iso; }
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

function applyFilters(){
  const q = (qs("q").value || "").trim().toLowerCase();
  const src = qs("sourceFilter").value;
  const cat = qs("categoryFilter").value;

  let items = state.allItems;

  if (src) items = items.filter(it => it.source === src);
  if (cat) items = items.filter(it => it.category === cat);
  if (q){
    items = items.filter(it=>{
      const hay = `${it.title||""} ${it.source||""} ${it.category||""} ${it.link||""}`.toLowerCase();
      return hay.includes(q);
    });
  }
  return items;
}

function render(items){
  qs("summary").textContent = `表示 ${items.length} 件（全読み込み ${state.allItems.length} 件）`;

  const list = qs("list");
  list.innerHTML = "";

  for (const it of items){
    const title = escapeHtml(it.title || "");
    const src = escapeHtml(it.source || "");
    const cat = escapeHtml(it.category || "");
    const date = escapeHtml(formatDate(it.pubDate || ""));
    const link = it.link || "";

    // ✅ ここがポイント：軽量は自前 lite.html に飛ばす
    const liteUrl = `./lite.html?u=${encodeURIComponent(link)}`;

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
        <a class="btn small" href="${escapeHtml(link)}" target="_blank" rel="noopener">元記事</a>
        <a class="btn primary small" href="${escapeHtml(liteUrl)}" target="_blank" rel="noopener">軽量表示</a>
        <button class="btn small" type="button" data-copy="${escapeHtml(link)}">URLコピー</button>
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

async function loadLatest(){
  setStatus("読み込み中…");
  const res = await fetch("./data/latest.ndjson", { cache:"no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const text = await res.text();
  state.latest = parseNdjson(text);
  state.allItems = uniqByLink(state.latest);

  populateFilters(state.allItems);
  render(state.allItems);
  setStatus(`準備OK（最新 ${state.latest.length} 件）`);
}

function initEvents(){
  qs("searchBtn").addEventListener("click", ()=>render(applyFilters()));
  qs("resetBtn").addEventListener("click", ()=>{
    qs("q").value = "";
    qs("sourceFilter").value = "";
    qs("categoryFilter").value = "";
    render(state.allItems);
  });
  qs("q").addEventListener("keydown", (e)=>{
    if (e.key === "Enter") render(applyFilters());
  });
  qs("sourceFilter").addEventListener("change", ()=>render(applyFilters()));
  qs("categoryFilter").addEventListener("change", ()=>render(applyFilters()));

  // スコープボタンはUIだけ先に（過去検索は次フェーズで拡張）
  qs("scopeLatestBtn").addEventListener("click", ()=>{
    qs("scopeLatestBtn").classList.add("active");
    qs("scopePastBtn").classList.remove("active");
    setStatus("直近3か月モード（いまはlatestのみ表示）");
  });
  qs("scopePastBtn").addEventListener("click", ()=>{
    qs("scopePastBtn").classList.add("active");
    qs("scopeLatestBtn").classList.remove("active");
    setStatus("過去検索は次の拡張でON（UIは先に用意済み）");
  });
}

(async function main(){
  try{
    initEvents();
    await loadLatest();
  }catch(e){
    console.error(e);
    setStatus(`エラー：${e.message}`);
  }
})();
