import type { Action, Prediction } from "../engine/predict.ts";
import { byWorth } from "../engine/rank.ts";
import { predictionsFor } from "../engine/run.ts";
import { movers, weeklyTop, type Mover } from "../engine/weekly.ts";
import { categorize, CATEGORIES, FOCUS, type CategoryKey } from "../categories.ts";
import { iconUrl, resolveIcons, wowheadUrl } from "../icons.ts";
import { dots, usesHint } from "../live/discord.ts";
import type { AppContext } from "./server.ts";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const when = (ms: number) =>
  new Date(ms).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const shortDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))} %`;

/** Gold wie im Spiel: 75g 93s in Münzfarben, Kupfer nur bei kleinen Beträgen */
function coins(copper: number): string {
  const c = Math.round(copper);
  const g = Math.floor(c / 10_000);
  const s = Math.floor((c % 10_000) / 100);
  const parts: string[] = [];
  if (g) parts.push(`<span class="g">${g}</span>`);
  if (s && g < 100) parts.push(`<span class="s">${s}</span>`);
  if (!g && (c % 100 || !s)) parts.push(`<span class="c">${c % 100}</span>`);
  return parts.join(" ");
}

const FIRST = 48; // so viele Karten pro Liste sofort, der Rest mit "Mehr anzeigen" oder Suche

type Meta = Map<number, { icon: string | null; quality: number | null }>;

function card(p: Prediction, meta: Meta): string {
  const m = meta.get(p.itemId);
  const quality = m?.quality ?? 1;
  const badge = p.action === "buy" ? pct(p.netUpside) : p.impact < 0 ? pct(p.impact) : "Peak";
  const price =
    p.currentPrice === null
      ? ""
      : p.expectedPeakPrice !== null && !(p.action === "sell" && p.impact >= 0)
        ? `${coins(p.currentPrice)} <span class="arrow">→</span> ${coins(p.expectedPeakPrice)}`
        : coins(p.currentPrice);
  const until = p.action === "buy" ? p.buyUntil : p.sellTo;
  const deadline = until ? `⏳ ${shortDate(until)}` : p.action === "sell" ? "⏳ jetzt" : "";
  const why = p.drivers[0] ? (p.source === "ai" ? p.drivers[0].reason : `${p.drivers[0].chain}. ${p.drivers[0].reason}`) : p.eventName;
  const icon = m?.icon
    ? `<img class="icon" src="${iconUrl(m.icon, "large")}" alt="" loading="lazy" width="48" height="48">`
    : `<span class="icon none">${esc(p.itemName.slice(0, 1))}</span>`;
  const use = usesHint(p);
  return `<article class="card ${p.action}" data-name="${esc(p.itemName.toLowerCase())}" data-cat="${p.category ?? "unknown"}">
  <a class="item q${quality}" href="${wowheadUrl(p.itemId)}" target="_blank" rel="noopener">${icon}<span class="name">${esc(p.itemName)}</span></a>
  <span class="badge">${badge}</span>
  <div class="price">${price}</div>
  <div class="meta">${catTag(p)}${deadline}<span class="dots" title="Sicherheit ${Math.round(p.confidence * 100)} %">${dots(p.confidence)}</span>${p.source === "ai" ? `<span class="ai" title="KI-Prognose">🤖</span>` : ""}</div>
  ${use ? `<div class="use" title="${esc((p.uses ?? []).join(", "))}">${esc(use)}</div>` : ""}
  <p class="why"><b>${esc(p.eventName)}</b> ${esc(why)}${p.uses?.length ? `<br><span class="needs">Verlangt von: ${esc(p.uses.join(", "))}</span>` : ""}</p>
</article>`;
}

/** Kleines Kategorie-Symbol mit Name als Tooltip */
function catTag(p: Prediction): string {
  const c = p.category && p.category !== "unknown" ? CATEGORIES[p.category] : null;
  return c ? `<span class="cat" title="${c.label}">${c.emoji}</span>` : "";
}

/** Ansichten der Kategorie-Leiste: Fokus zuerst, BoE-Ausrüstung gibt es gar nicht */
const VIEWS: Array<{ key: string; label: string; cats: CategoryKey[] }> = [
  { key: "focus", label: "🎯 Fokus", cats: FOCUS },
  { key: "trade", label: `${CATEGORIES.trade.emoji} ${CATEGORIES.trade.label}`, cats: ["trade"] },
  { key: "faction", label: `${CATEGORIES.faction.emoji} ${CATEGORIES.faction.label}`, cats: ["faction"] },
  { key: "consumable", label: `${CATEGORIES.consumable.emoji} ${CATEGORIES.consumable.label}`, cats: ["consumable"] },
  { key: "recipe", label: `${CATEGORIES.recipe.emoji} ${CATEGORIES.recipe.label}`, cats: ["recipe"] },
  { key: "all", label: "Alle", cats: ["trade", "faction", "consumable", "recipe", "other", "unknown"] },
];

function iconTag(itemId: number, name: string, meta: Meta, size = 40): string {
  const m = meta.get(itemId);
  return m?.icon
    ? `<img class="icon" src="${iconUrl(m.icon, "large")}" alt="" loading="lazy" width="${size}" height="${size}">`
    : `<span class="icon none">${esc(name.slice(0, 1))}</span>`;
}

/** Eine Rangliste: Platz, Icon, Name, Badge, darunter Preis, Frist, Sicherheit. Klick zeigt die Begründung. */
function topList(title: string, hint: string, action: Action, list: Prediction[], meta: Meta): string {
  const rows = list.map((p, i) => {
    const badge = p.action === "buy" ? pct(p.netUpside) : p.impact < 0 ? pct(p.impact) : "Peak";
    const price =
      p.currentPrice === null
        ? ""
        : p.expectedPeakPrice !== null && !(p.action === "sell" && p.impact >= 0)
          ? `${coins(p.currentPrice)} <span class="arrow">→</span> ${coins(p.expectedPeakPrice)}`
          : coins(p.currentPrice);
    const until = p.action === "buy" ? p.buyUntil : p.sellTo;
    const deadline = until ? `⏳ ${shortDate(until)}` : p.action === "sell" ? "⏳ jetzt" : "";
    const why = p.drivers[0] ? (p.source === "ai" ? p.drivers[0].reason : `${p.drivers[0].chain}. ${p.drivers[0].reason}`) : p.eventName;
    return `<li class="rank">
      <span class="pos">${i + 1}</span>
      <a class="item q${meta.get(p.itemId)?.quality ?? 1}" href="${wowheadUrl(p.itemId)}" target="_blank" rel="noopener">${iconTag(p.itemId, p.itemName, meta)}<span class="name">${esc(p.itemName)}</span></a>
      <span class="badge">${badge}</span>
      <div class="sub">${catTag(p)}<span class="price">${price}</span>${deadline ? `<span>${deadline}</span>` : ""}<span class="dots" title="Sicherheit ${Math.round(p.confidence * 100)} %">${dots(p.confidence)}</span>${usesHint(p) ? `<span class="use">${esc(usesHint(p)!)}</span>` : ""}</div>
      <p class="why"><b>${esc(p.eventName)}</b> ${esc(why)}${p.uses?.length ? `<br><span class="needs">Verlangt von: ${esc(p.uses.join(", "))}</span>` : ""}</p>
    </li>`;
  });
  return `<section class="top ${action}"><h2>${title}<span>${hint}</span></h2>${
    rows.length ? `<ol>${rows.join("")}</ol>` : `<p class="empty">Gerade nichts.</p>`
  }</section>`;
}

/** Was sich in den eigenen Scans seit der Vorwoche wirklich bewegt hat, nur wenn es Daten gibt */
function moverLists(moved: { up: Mover[]; down: Mover[] }, meta: Meta): string {
  if (moved.up.length + moved.down.length === 0) return "";
  const list = (title: string, kind: "buy" | "sell", items: Mover[]) =>
    `<section class="moved ${kind}"><h3>${title}</h3>${
      items.length
        ? `<ol>${items
            .map(
              (m) => `<li><a class="item q${meta.get(m.itemId)?.quality ?? 1}" href="${wowheadUrl(m.itemId)}" target="_blank" rel="noopener">${iconTag(m.itemId, m.name, meta, 28)}<span class="name">${esc(m.name)}</span></a>
              <span class="chg">${pct(m.change)}</span><span class="was">${coins(m.before)} <span class="arrow">→</span> ${coins(m.price)}</span></li>`,
            )
            .join("")}</ol>`
        : `<p class="empty">Nichts Auffälliges.</p>`
    }</section>`;
  return `<h2 class="sect">📊 Echte Bewegung seit letzter Woche</h2><div class="duo">${list("🚀 Gestiegen", "buy", moved.up)}${list("🔻 Gefallen", "sell", moved.down)}</div>`;
}

function grid(list: Prediction[], meta: Meta): string {
  if (list.length === 0) return `<p class="empty">Gerade nichts.</p>`;
  const cards = list.map((p, i) => card(p, meta).replace('<article class="card', i < FIRST ? '<article class="card' : '<article class="card later'));
  const more = list.length > FIRST ? `<button class="more" type="button">Alle ${list.length} anzeigen</button>` : "";
  return `<div class="grid">${cards.join("")}</div>${more}`;
}

const STYLE = `
:root { color-scheme: dark; --bg: #0e1014; --panel: #161920; --card: #1b1f27; --line: #2a2f3a; --fg: #ecebe8; --muted: #9298a2;
  --red: #ff5f52; --green: #3ddc84; --gold: #f2c94c; --silver: #c9ced6; --copper: #d58a54; --accent: #e0a25a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 56px; }
a { color: inherit; text-decoration: none; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-bottom: 18px; }
h1 { font-size: 1.35rem; margin: 0; display: flex; align-items: center; gap: 10px; }
.live { width: 10px; height: 10px; border-radius: 50%; background: var(--green); box-shadow: 0 0 10px var(--green); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; color: var(--muted); font-size: .85rem; white-space: nowrap; }
.chip b { color: var(--fg); font-weight: 600; }
.chip a { color: var(--accent); }
.bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 8px 0 16px; }
.tabs { display: flex; gap: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 4px; }
.tab { border: 0; background: none; color: var(--muted); font: inherit; font-weight: 600; padding: 7px 14px; border-radius: 9px; cursor: pointer; }
.tab[aria-selected="true"] { background: var(--card); color: var(--fg); }
.tab .n { color: var(--muted); font-weight: 500; margin-left: 4px; }
.search { flex: 1 1 220px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px; color: var(--fg); font: inherit; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
.card { position: relative; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 12px 10px; cursor: pointer;
  border-left: 3px solid var(--red); transition: border-color .15s, transform .15s; }
.card.buy { border-left-color: var(--green); }
.card:hover { border-color: #3a4150; transform: translateY(-1px); }
.card.later, .card.hide { display: none; }
.showall .card.later { display: block; }
.showall .card.later.hide { display: none; }
.item { display: flex; align-items: center; gap: 10px; padding-right: 64px; min-height: 48px; }
.icon { width: 48px; height: 48px; border-radius: 8px; border: 2px solid #555; flex: none; background: #000; }
.icon.none { display: grid; place-items: center; color: var(--muted); font-weight: 700; font-size: 1.2rem; }
.name { font-weight: 600; line-height: 1.25; }
.q0 .name { color: #9d9d9d; } .q0 .icon { border-color: #9d9d9d; }
.q1 .name { color: #ffffff; } .q1 .icon { border-color: #6b6b6b; }
.q2 .name { color: #1eff00; } .q2 .icon { border-color: #1eff00; }
.q3 .name { color: #3d9bff; } .q3 .icon { border-color: #0070dd; }
.q4 .name { color: #b65cff; } .q4 .icon { border-color: #a335ee; }
.q5 .name { color: #ff8000; } .q5 .icon { border-color: #ff8000; }
.badge { position: absolute; top: 12px; right: 12px; font-weight: 800; font-size: 1.05rem; padding: 3px 9px; border-radius: 8px;
  color: var(--red); background: rgba(255, 95, 82, .12); font-variant-numeric: tabular-nums; }
.buy .badge { color: var(--green); background: rgba(61, 220, 132, .12); }
.price { margin-top: 8px; font-weight: 600; font-variant-numeric: tabular-nums; }
.price .arrow { color: var(--muted); margin: 0 2px; }
.g { color: var(--gold); } .g::after { content: "g"; opacity: .8; margin-left: 1px; }
.s { color: var(--silver); } .s::after { content: "s"; opacity: .8; margin-left: 1px; }
.c { color: var(--copper); } .c::after { content: "c"; opacity: .8; margin-left: 1px; }
.meta { display: flex; gap: 10px; align-items: center; margin-top: 4px; color: var(--muted); font-size: .85rem; }
.dots { letter-spacing: 1px; color: var(--accent); }
.why { display: none; margin: 8px 0 0; padding-top: 8px; border-top: 1px solid var(--line); color: var(--muted); font-size: .88rem; }
.why b { color: var(--fg); font-weight: 600; margin-right: 4px; }
.card.open .why { display: block; }
.more { margin: 14px auto 0; display: block; background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 10px; padding: 9px 16px; font: inherit; cursor: pointer; }
.showall + .more, .searching .more { display: none; }
.empty { color: var(--muted); }
.panel { display: none; } .panel.active { display: block; }
.login { max-width: 420px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px; }
.login form { display: flex; gap: 8px; margin-top: 12px; }
.login input { flex: 1; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; color: var(--fg); font: inherit; }
.login button { background: var(--accent); color: #1b1206; border: 0; border-radius: 10px; padding: 9px 16px; font-weight: 700; cursor: pointer; }
.muted { color: var(--muted); }
code { background: var(--panel); padding: 1px 6px; border-radius: 6px; }
.duo { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 14px; margin: 16px 0; }
.top { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px 14px 6px; border-top: 3px solid var(--green); }
.top.sell { border-top-color: var(--red); }
.top h2, .moved h3 { margin: 0 0 10px; font-size: 1.05rem; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.top h2 span { color: var(--muted); font-size: .8rem; font-weight: 500; }
.top ol, .moved ol { list-style: none; margin: 0; padding: 0; }
.rank { display: grid; grid-template-columns: 26px 1fr auto; column-gap: 10px; align-items: center; padding: 8px 4px; border-top: 1px solid var(--line); cursor: pointer; }
.rank:first-child { border-top: 0; }
.rank .pos { grid-row: span 2; align-self: center; text-align: center; font-weight: 800; color: var(--muted); font-variant-numeric: tabular-nums; }
.rank:nth-child(-n+3) .pos { color: var(--accent); font-size: 1.1rem; }
.rank .item { padding-right: 0; min-height: 40px; }
.rank .icon { width: 40px; height: 40px; }
.rank .badge { position: static; justify-self: end; }
.rank .sub { grid-column: 2 / 4; display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font-size: .85rem; margin-top: 4px; }
.rank .sub .price { font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }
.rank .why { grid-column: 2 / 4; }
.rank.open .why { display: block; }
.sell .badge { color: var(--red); background: rgba(255, 95, 82, .12); }
.buy .badge { color: var(--green); background: rgba(61, 220, 132, .12); }
.sect { font-size: 1rem; color: var(--muted); margin: 22px 0 0; }
.moved { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
.moved li { display: grid; grid-template-columns: 1fr auto; column-gap: 10px; align-items: center; padding: 6px 0; border-top: 1px solid var(--line); }
.moved li:first-child { border-top: 0; }
.moved .item { padding-right: 0; min-height: 28px; gap: 8px; }
.moved .icon { width: 28px; height: 28px; border-radius: 6px; }
.moved .chg { font-weight: 800; color: var(--green); }
.moved.sell .chg { color: var(--red); }
.moved .was { grid-column: 1 / 3; color: var(--muted); font-size: .82rem; padding-left: 36px; }
.all-toggle { display: block; margin: 18px auto; background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 12px; padding: 10px 18px; font: inherit; font-weight: 600; cursor: pointer; }
.all-toggle.on { border-color: var(--accent); }
.cats { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 0; }
.catbtn { background: var(--panel); border: 1px solid var(--line); color: var(--muted); font: inherit; font-weight: 600; padding: 7px 12px; border-radius: 999px; cursor: pointer; }
.catbtn .n { margin-left: 6px; font-weight: 500; opacity: .8; }
.catbtn[aria-pressed="true"] { background: var(--card); color: var(--fg); border-color: var(--accent); }
.cat { cursor: default; }
.use { color: var(--accent); font-size: .82rem; font-weight: 600; }
.card .use { margin-top: 4px; }
.needs { color: var(--muted); font-size: .82rem; }
`;

const SCRIPT = `
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(o => o.setAttribute('aria-selected', o === t));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === t.dataset.panel));
}));
document.querySelectorAll('.more').forEach(b => b.addEventListener('click', () => b.previousElementSibling.classList.add('showall')));
document.addEventListener('click', e => {
  const c = e.target.closest('.card, .rank');
  if (c && !e.target.closest('a')) c.classList.toggle('open');
});
document.querySelectorAll('.all-toggle').forEach(b => b.addEventListener('click', () => {
  const all = document.querySelector('.all');
  all.hidden = !all.hidden;
  b.classList.toggle('on', !all.hidden);
  if (!all.hidden) all.scrollIntoView({ behavior: 'smooth', block: 'start' });
}));
// Kategorie und Suche wirken zusammen auf die Liste aller Signale
let cats = (document.querySelector('.catbtn[aria-pressed="true"]')?.dataset.cats || '').split(' ').filter(Boolean);
const q = document.querySelector('.search');
function filter() {
  const v = q ? q.value.trim().toLowerCase() : '';
  const narrowed = !!v || cats.length > 0;
  document.querySelectorAll('.grid').forEach(g => { g.classList.toggle('showall', narrowed); g.parentElement.classList.toggle('searching', narrowed); });
  document.querySelectorAll('.card').forEach(c => {
    const ok = (!v || c.dataset.name.includes(v)) && (cats.length === 0 || cats.includes(c.dataset.cat));
    c.classList.toggle('hide', !ok);
  });
}
if (q) q.addEventListener('input', filter);
document.querySelectorAll('.catbtn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.catbtn').forEach(o => o.setAttribute('aria-pressed', o === b));
  document.querySelectorAll('.catview').forEach(v => { v.hidden = v.dataset.view !== b.dataset.view; });
  cats = b.dataset.view === 'all' ? [] : b.dataset.cats.split(' ');
  filter();
}));
filter();
`;

/**
 * Startseite. Ohne Leserecht nur "läuft" und ein Feld für den READ_TOKEN.
 * Mit Leserecht: Verkaufen und Kaufen als Karten mit Icons, Suche, Wowhead-Tooltips.
 */
export function homePage(ctx: AppContext, req: Request, allowed: boolean): Response {
  const token = new URL(req.url).searchParams.get("token");
  const link = (path: string) => {
    if (!token || !ctx.config.readToken) return esc(path);
    return esc(`${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`);
  };

  let body: string;
  if (!allowed) {
    body = `
      <div class="login">
        <p>Die Daten sind geschützt. Mit dem <code>READ_TOKEN</code> siehst du, was du jetzt verkaufen oder kaufen solltest.</p>
        <form method="get" action="/">
          <input type="password" name="token" placeholder="READ_TOKEN" autocomplete="current-password" required>
          <button type="submit">Anzeigen</button>
        </form>
        ${token ? `<p class="muted">Der Token stimmt nicht.</p>` : ""}
      </div>`;
  } else {
    const realms = ctx.repo.overview();
    const brief = ctx.repo.latestBrief();
    const main = realms[0];
    if (!main) {
      body = `<p class="muted">Noch kein Scan. Im Spiel am Auktionshaus <code>/wahp</code> öffnen und scannen, der Companion lädt ihn hoch.</p>`;
    } else {
      const predictions = predictionsFor(ctx, main.realm, (ctx.now ?? Date.now)());
      const pick = (a: Action) => predictions.filter((p) => p.action === a).sort(byWorth);
      const sells = pick("sell");
      const buys = pick("buy");
      const ids = [...sells, ...buys].map((p) => p.itemId);
      const meta = ctx.repo.itemMeta(ids);
      // Fehlende Icons im Hintergrund holen, beim nächsten Laden sind sie da
      const missing = ids.filter((id) => !meta.get(id)?.icon);
      if (missing.length > 0) void resolveIcons(ctx.repo, missing, { max: 120, fetchImpl: ctx.iconFetch }).catch(() => {});
      // Echte Bewegung aus den Scans, mit Kategorie (BoE-Ausrüstung raus) und Namen wie bei den Prognosen
      const market = ctx.repo.marketItems(main.realm, (ctx.now ?? Date.now)());
      const facts = ctx.repo.itemFacts(market.map((i) => i.itemId));
      const needs = ctx.repo.factionNeeds();
      const known = new Map<number, string>([
        ...ctx.knowledge.items.map((i) => [i.id, i.name] as [number, string]),
        ...predictions.map((p) => [p.itemId, p.itemName] as [number, string]),
      ]);
      for (const i of market) {
        const f = facts.get(i.itemId);
        i.kind = categorize({ name: i.name, classId: f?.classId ?? null, whKind: f?.whKind ?? null }, needs.has(i.itemId));
        if (!i.name) i.name = known.get(i.itemId) ?? null;
      }
      const relevant = market.filter((i) => i.kind !== "gear");
      const allMoved = movers(relevant, 50);
      const movedAll = [...allMoved.up, ...allMoved.down];
      const movedMeta = ctx.repo.itemMeta(movedAll.map((m) => m.itemId));
      const kindOf = new Map(relevant.map((i) => [i.itemId, i.kind ?? "unknown"]));
      const count = (cats: CategoryKey[]) => predictions.filter((p) => cats.includes(p.category ?? "unknown") && (p.action === "buy" || p.action === "sell")).length;
      const views = VIEWS.map((v, i) => {
        const inView = (p: Prediction) => v.cats.includes(p.category ?? "unknown");
        const top = weeklyTop(predictions.filter(inView));
        const moved = movers(relevant.filter((m) => v.cats.includes(kindOf.get(m.itemId) ?? "unknown")));
        return `<div class="catview" data-view="${v.key}"${i === 0 ? "" : " hidden"}>
          <div class="duo">
            ${topList("📈 Gewinner der Woche", "jetzt kaufen", "buy", top.winners, meta)}
            ${topList("📉 Verlierer der Woche", "jetzt verkaufen", "sell", top.losers, meta)}
          </div>
          ${moverLists(moved, movedMeta)}
        </div>`;
      });
      body = `
        <div class="chips">
          <span class="chip">🌍 <b>${esc(main.realm)}</b></span>
          <span class="chip">📦 Scan <b>${when(main.lastScan)}</b> · ${main.items} Items</span>
          <span class="chip">🤖 <b>${main.assessed}</b> bewertet</span>
          ${brief ? `<span class="chip">📰 <a href="${link("/brief")}">Lagebericht ${when(brief.createdAt)}</a> · ${brief.sources.length} Quellen</span>` : ""}
        </div>
        <nav class="cats" aria-label="Kategorien">${VIEWS.map(
          (v, i) => `<button class="catbtn" type="button" data-view="${v.key}" data-cats="${v.cats.join(" ")}" aria-pressed="${i === 0}">${v.label}<span class="n">${count(v.cats)}</span></button>`,
        ).join("")}</nav>
        ${views.join("")}
        <button class="all-toggle" type="button">🔎 Alle ${sells.length + buys.length} Signale durchsuchen</button>
        <div class="all" hidden>
          <div class="bar">
            <div class="tabs" role="tablist">
              <button class="tab" role="tab" aria-selected="true" data-panel="sell">🔴 Verkaufen<span class="n">${sells.length}</span></button>
              <button class="tab" role="tab" aria-selected="false" data-panel="buy">🟢 Kaufen<span class="n">${buys.length}</span></button>
            </div>
            <input class="search" type="search" placeholder="Item suchen …" aria-label="Item suchen">
          </div>
          <section class="panel active" id="sell">${grid(sells, meta)}</section>
          <section class="panel" id="buy">${grid(buys, meta)}</section>
        </div>`;
    }
  }

  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>AH-Prognose</title><style>${STYLE}</style>
<script>const whTooltips = { colorLinks: false, iconizeLinks: false, renameLinks: false };</script>
<script src="https://wow.zamimg.com/js/tooltips.js" async></script></head>
<body><main>
  <header><h1><span class="live"></span>AH-Prognose</h1><span class="muted">WoW Forever</span></header>
  ${body}
</main><script>${SCRIPT}</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
