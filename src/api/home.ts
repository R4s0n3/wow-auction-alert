import type { AppContext } from "./server.ts";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const when = (ms: number) =>
  new Date(ms).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" });

const STYLE = `
:root { color-scheme: light dark; --bg: #f6f5f2; --fg: #1d1c1a; --muted: #6b6862; --card: #fff; --line: #e3e0da; --accent: #a8641e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #ecebe8; --muted: #a09c94; --card: #1f1e1b; --line: #34322e; --accent: #e0a25a; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h2 { font-size: 1rem; margin: 28px 0 8px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
p { margin: 0 0 12px; }
.muted { color: var(--muted); }
.ok { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #3a9a5b; margin-right: 8px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 12px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: .875rem; }
.scroll { overflow-x: auto; }
a { color: var(--accent); }
ul { margin: 0; padding-left: 20px; }
form { display: flex; gap: 8px; flex-wrap: wrap; }
input { flex: 1 1 240px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
button { padding: 8px 14px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
`;

/**
 * Startseite. Ohne Leserecht nur "läuft" und ein Feld für den READ_TOKEN,
 * mit Leserecht ein Überblick pro Realm und Links auf alle Ansichten.
 */
export function homePage(ctx: AppContext, req: Request, allowed: boolean): Response {
  const token = new URL(req.url).searchParams.get("token");
  // Token an Links nur hängen, wenn er per ?token= kam (Browser)
  const link = (path: string) => {
    if (!token || !ctx.config.readToken) return esc(path);
    return esc(`${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`);
  };

  let body: string;
  if (!allowed) {
    body = `
      <div class="card">
        <p>Die Daten sind geschützt. Mit dem <code>READ_TOKEN</code> siehst du Scans, KI-Bewertungen und Prognosen.</p>
        <form method="get" action="/">
          <input type="password" name="token" placeholder="READ_TOKEN" autocomplete="current-password" required>
          <button type="submit">Anzeigen</button>
        </form>
        ${token ? `<p class="muted" style="margin-top:12px">Der Token stimmt nicht.</p>` : ""}
      </div>`;
  } else {
    const realms = ctx.repo.overview();
    const brief = ctx.repo.latestBrief();
    const rows = realms
      .map(
        (r) => `<tr><td>${esc(r.realm)}</td><td>${when(r.lastScan)}</td><td>${r.items}</td><td>${r.assessed}</td>
          <td><a href="${link(`/predictions?realm=${r.realm}`)}">Prognosen</a> ·
          <a href="${link(`/assessments?realm=${r.realm}&direction=up`)}">steigt</a> ·
          <a href="${link(`/assessments?realm=${r.realm}&direction=down`)}">fällt</a> ·
          <a href="${link(`/alerts?realm=${r.realm}`)}">Alerts</a></td></tr>`,
      )
      .join("");
    body = `
      <h2>Realms</h2>
      <div class="card">${
        realms.length === 0
          ? `<p>Noch kein Scan. Im Spiel <code>/wahp scan</code>, dann <code>/reload</code>, der Companion lädt ihn hoch.</p>`
          : `<div class="scroll"><table><thead><tr><th>Realm</th><th>Letzter Scan</th><th>Items</th><th>KI-Bewertungen</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      }</div>
      <h2>KI-Lagebericht</h2>
      <div class="card">${
        brief
          ? `<p>Vom ${when(brief.createdAt)} (${esc(brief.model)}), ${brief.sources.length} Quellen. <a href="${link("/brief")}">Lesen</a></p>`
          : `<p>Noch keiner. Kommt mit der ersten KI-Analyse (<code>bun run analyze</code>).</p>`
      }</div>
      <h2>Weitere Ansichten</h2>
      <div class="card"><ul>
        <li><a href="${link(`/predictions?realm=${ctx.config.defaultRealm}`)}">Prognosen (Standard-Realm ${esc(ctx.config.defaultRealm)})</a></li>
        <li><a href="${link("/events")}">Event-Kalender mit Kauf- und Verkaufsfenstern</a></li>
        <li><a href="${link(`/stream?realm=${ctx.config.defaultRealm}`)}">Live-Stream (Server-Sent Events)</a></li>
      </ul></div>`;
  }

  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>AH-Prognose</title><style>${STYLE}</style></head>
<body><main>
  <h1><span class="ok"></span>AH-Prognose-Server läuft</h1>
  <p class="muted">WoW Forever · Prognosen aus AH-Scans und KI-Recherche</p>
  ${body}
</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
