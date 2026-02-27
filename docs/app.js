async function loadJson() {
  const res = await fetch("news.json", { cache: "no-store" });
  return await res.json();
}

// スペースでAND、各トークン内で | をOR
// 例: "中国 輸出|規制" => [["中国"], ["輸出","規制"]]
function parseQuery(q) {
  const tokens = q.split(/\s+/).map(s => s.trim()).filter(Boolean);
  return tokens.map(t => t.split("|").map(x => x.trim()).filter(Boolean)).filter(g => g.length);
}

function withinDays(publishedIso, days) {
  if (!publishedIso) return true;
  const t = new Date(publishedIso).getTime();
  const now = Date.now();
  return (now - t) <= days * 24 * 60 * 60 * 1000;
}

// AND: groups every must match
// OR: within group at least one matches
function matchQuery(item, groups) {
  if (!groups.length) return true;
  const hay = (item.title + " " + (item.summary || "")).toLowerCase();
  return groups.every(group => group.some(term => hay.includes(term.toLowerCase())));
}

function escapeHtml(s){
  return (s||"").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function render(items) {
  const el = document.getElementById("list");
  el.innerHTML = "";
  for (const it of items) {
    const div = document.createElement("div");
    div.className = "item";
    div.innerHTML = `
      <div class="meta">${escapeHtml(it.source)} / ${(it.published||"").slice(0,10)}</div>
      <div class="title">${escapeHtml(it.title)}</div>
      <div class="meta">${escapeHtml((it.summary||"").slice(0,220))}</div>
      <div style="margin-top:8px"><a href="${it.url}" target="_blank" rel="noopener">開く</a></div>
    `;
    el.appendChild(div);
  }
}

let ALL = [];

function updateSourcesSelect() {
  const sel = document.getElementById("src");
  const sources = Array.from(new Set(ALL.map(x => x.source))).sort();
  for (const s of sources) {
    const opt = document.createElement("option");
    opt.value = s; opt.textContent = s;
    sel.appendChild(opt);
  }
}

function apply() {
  const q = document.getElementById("q").value;
  const src = document.getElementById("src").value;
  const days = parseInt(document.getElementById("days").value, 10);

  const groups = parseQuery(q);

  const filtered = ALL
    .filter(it => !src || it.source === src)
    .filter(it => withinDays(it.published, days))
    .filter(it => matchQuery(it, groups))
    .slice(0, 200);

  document.getElementById("status").textContent =
    `総件数: ${ALL.length} / ヒット: ${filtered.length}`;
  render(filtered);
}

async function main(){
  ALL = await loadJson();
  updateSourcesSelect();
  document.getElementById("status").textContent = `総件数: ${ALL.length}`;
  ["q","src","days"].forEach(id => {
    document.getElementById(id).addEventListener("input", apply);
    document.getElementById(id).addEventListener("change", apply);
  });
  apply();
}

main();
