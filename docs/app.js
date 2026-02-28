// docs/app.js
let NEWS = [];

const RANGE_OPTIONS = [
  { label: "直近7日", days: 7 },
  { label: "直近30日", days: 30 },
  { label: "直近180日", days: 180 },
  { label: "直近1年", days: 365 },
  { label: "全期間", days: null },
];

const PREVIEW_MAX_CHARS = 280;

function qs(id) { return document.getElementById(id); }

function parseQuery(q) {
  // スペース=AND, | =OR
  // 例: "中国 輸出|規制" => [["中国"],["輸出","規制"]]
  q = (q || "").trim();
  if (!q) return [];
  const andParts = q.split(/\s+/).filter(Boolean);
  return andParts.map(part => part.split("|").map(x => x.trim()).filter(Boolean));
}

function textOf(item) {
  return `${item.title || ""} ${item.summary || ""} ${item.source || ""} ${item.category || ""}`.toLowerCase();
}

function withinDays(item, days) {
  if (!days) return true;
  const base = item.published || item.fetchedAt;
  if (!base) return true;
  const t = Date.parse(base);
  if (Number.isNaN(t)) return true;
  const now = Date.now();
  const diffDays = (now - t) / (1000 * 60 * 60 * 24);
  return diffDays <= days;
}

function match(item, groups) {
  if (!groups.length) return true;
  const txt = textOf(item);
  // AND: 全グループがtrue
  // OR: そのグループ内のどれかが含まれる
  return groups.every(orGroup => orGroup.some(word => txt.includes(word.toLowerCase())));
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function initSelect(el, options, defaultValue) {
  el.innerHTML = "";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    el.appendChild(o);
  }
  el.value = defaultValue ?? options[0]?.value ?? "";
}

function formatDate(item) {
  const d = (item.published || item.fetchedAt || "").slice(0, 10);
  return d || "";
}

function buildPreviewText(summary) {
  const s = (summary || "").trim();
  if (!s) return "";
  return s.length > PREVIEW_MAX_CHARS ? s.slice(0, PREVIEW_MAX_CHARS) + "…" : s;
}

function render() {
  const q = qs("q").value;
  const groups = parseQuery(q);

  const source = qs("source").value;
  const category = qs("category").value;

  const rangeLabel = qs("range").value;
  const range = RANGE_OPTIONS.find(x => x.label === rangeLabel);
  const days = range ? range.days : 30;

  const filtered = NEWS.filter(item => {
    if (source !== "全ソース" && item.source !== source) return false;
    if (category !== "全カテゴリ" && (item.category || "その他") !== category) return false;
    if (!withinDays(item, days)) return false;
    if (!match(item, groups)) return false;
    return true;
  });

  qs("meta").textContent = `総件数: ${NEWS.length} / ヒット: ${filtered.length}`;

  const list = qs("list");
  list.innerHTML = "";

  for (const item of filtered) {
    const card = document.createElement("div");
    card.className = "card";

    // header line
    const top = document.createElement("div");
    top.className = "small";
    top.textContent = `${item.source || ""} / ${(item.category || "その他")} / ${formatDate(item)}`;
    card.appendChild(top);

    // title
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = item.title || "(no title)";
    card.appendChild(title);

    // actions row
    const actions = document.createElement("div");
    actions.className = "actions";

    // open link
    const a = document.createElement("a");
    a.href = item.link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "開く";
    actions.appendChild(a);

    // preview toggle (card内で開く)
    const summaryText = buildPreviewText(item.summary || "");
    if (summaryText) {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.type = "button";
      btn.textContent = "プレビュー";

      const preview = document.createElement("div");
      preview.className = "preview";
      preview.style.display = "none";
      preview.textContent = summaryText;

      btn.addEventListener("click", () => {
        const isOpen = preview.style.display !== "none";
        preview.style.display = isOpen ? "none" : "block";
        btn.textContent = isOpen ? "プレビュー" : "閉じる";
      });

      actions.appendChild(btn);
      card.appendChild(actions);
      card.appendChild(preview);
    } else {
      // summaryが無い場合でもUIが崩れないように
      card.appendChild(actions);
    }

    list.appendChild(card);
  }
}

async function main() {
  const res = await fetch("./news.json", { cache: "no-store" });
  NEWS = await res.json();

  // ソース一覧
  const sources = uniq(NEWS.map(x => x.source).filter(Boolean)).sort();
  initSelect(
    qs("source"),
    [{ label: "全ソース", value: "全ソース" }].concat(sources.map(s => ({ label: s, value: s }))),
    "全ソース"
  );

  // カテゴリ一覧（3分類 + 全カテゴリ）
  const categories = ["規制・輸出", "物価", "その他"];
  initSelect(
    qs("category"),
    [{ label: "全カテゴリ", value: "全カテゴリ" }].concat(categories.map(c => ({ label: c, value: c }))),
    "全カテゴリ"
  );

  // 期間
  initSelect(
    qs("range"),
    RANGE_OPTIONS.map(x => ({ label: x.label, value: x.label })),
    "直近30日"
  );

  // イベント
  qs("q").addEventListener("input", render);
  qs("source").addEventListener("change", render);
  qs("category").addEventListener("change", render);
  qs("range").addEventListener("change", render);

  render();
}

main();
