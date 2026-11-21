import { timingSafeEqual } from "node:crypto";
import type { Config } from "../config.ts";
import type { Repo, ScanItem } from "../db/repo.ts";
import { curveFor, windowsFor } from "../engine/curve.ts";
import type { Action } from "../engine/predict.ts";
import { predictionsFor } from "../engine/run.ts";
import { toAddonLua } from "../export/lua.ts";
import type { Knowledge } from "../knowledge/types.ts";
import type { LiveHub } from "../live/hub.ts";
import { homePage } from "./home.ts";

export interface AppContext {
  repo: Repo;
  knowledge: Knowledge;
  config: Config;
  hub: LiveHub;
  now?: () => number;
  /** Wird nach jedem Scan-Upload aufgerufen, damit Alerts sofort rausgehen */
  onScan?: () => void | Promise<void>;
}

const REALM_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const ACTIONS = new Set<Action>(["buy", "hold", "sell", "avoid", "watch"]);
const MAX_SCAN_ITEMS = 50_000;
const DIRECTIONS = new Set(["up", "down", "flat"]);

const error = (status: number, message: string) => Response.json({ error: message }, { status });

function same(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req: Request, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  return same(header.startsWith("Bearer ") ? header.slice(7) : "", token);
}

/**
 * Lesen ist ohne READ_TOKEN offen (lokal). Mit READ_TOKEN braucht jede Route außer
 * /health einen Token: READ_TOKEN oder INGEST_TOKEN, als Bearer-Header oder ?token=
 * (für den Browser und EventSource, die keine Header setzen können).
 */
function canRead(req: Request, config: Config): boolean {
  if (!config.readToken) return true;
  const query = new URL(req.url).searchParams.get("token");
  return [config.readToken, config.ingestToken].some((t) => t !== "" && (authorized(req, t) || (query !== null && same(query, t))));
}

const denied = () => error(401, "Lesen braucht einen Token: Authorization: Bearer <READ_TOKEN> oder ?token=<READ_TOKEN>");

const optionalText = (v: unknown, max: number) => v === undefined || (typeof v === "string" && v.length > 0 && v.length <= max);

type ParsedScan = { realm: string; source: string; scannedAt: number; items: ScanItem[] };

function parseScan(body: unknown): ParsedScan | string {
  if (typeof body !== "object" || body === null) return "Body muss ein JSON-Objekt sein";
  const b = body as Record<string, unknown>;
  if (typeof b.realm !== "string" || !REALM_RE.test(b.realm)) return "realm fehlt oder ist ungültig";
  const source = b.source === undefined ? "unknown" : b.source;
  if (typeof source !== "string" || source.length > 64) return "source ist ungültig";
  if (typeof b.scannedAt !== "number" || !Number.isInteger(b.scannedAt) || b.scannedAt <= 0) {
    return "scannedAt muss ein Unix-Zeitstempel in Sekunden sein";
  }
  if (!Array.isArray(b.items) || b.items.length === 0) return "items muss ein nicht-leeres Array sein";
  if (b.items.length > MAX_SCAN_ITEMS) return `maximal ${MAX_SCAN_ITEMS} Items pro Scan`;

  const items: ScanItem[] = [];
  for (const [i, raw] of b.items.entries()) {
    const it = raw as Record<string, unknown> | null;
    const ok =
      it &&
      Number.isInteger(it.itemId) && (it.itemId as number) > 0 &&
      Number.isInteger(it.minBuyout) && (it.minBuyout as number) > 0 &&
      (it.marketPrice === undefined || (Number.isInteger(it.marketPrice) && (it.marketPrice as number) > 0)) &&
      (it.quantity === undefined || (Number.isInteger(it.quantity) && (it.quantity as number) >= 0)) &&
      optionalText(it.name, 120) &&
      optionalText(it.category, 80) &&
      (it.quality === undefined || (Number.isInteger(it.quality) && (it.quality as number) >= 0 && (it.quality as number) <= 8));
    if (!ok) {
      return `items[${i}]: braucht itemId, minBuyout (Kupfer) und optional marketPrice/quantity als ganze Zahlen, name/category als kurzen Text, quality 0-8`;
    }
    items.push({
      itemId: it.itemId as number,
      minBuyout: it.minBuyout as number,
      marketPrice: it.marketPrice as number | undefined,
      quantity: (it.quantity as number) ?? 0,
      name: it.name as string | undefined,
      quality: it.quality as number | undefined,
      category: it.category as string | undefined,
    });
  }
  return { realm: b.realm, source, scannedAt: b.scannedAt, items };
}

export function startServer(ctx: AppContext, port = ctx.config.port) {
  const now = ctx.now ?? Date.now;
  const realmOf = (req: Request): string | null => {
    const realm = new URL(req.url).searchParams.get("realm") ?? ctx.config.defaultRealm;
    return REALM_RE.test(realm) ? realm : null;
  };

  return Bun.serve({
    port,
    maxRequestBodySize: 10 * 1024 * 1024,
    routes: {
      "/": (req) => homePage(ctx, req, canRead(req, ctx.config)),
      "/favicon.ico": () => new Response(null, { status: 204 }),
      "/health": () => Response.json({ ok: true }),

      "/events": (req) => {
        if (!canRead(req, ctx.config)) return denied();
        const t = now();
        return Response.json(
          ctx.knowledge.events.map((e) => {
            const w = windowsFor(e, curveFor(e));
            const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
            return {
              ...e,
              status: t < w.runUpStart ? "upcoming" : t < w.expires ? "active" : "past",
              runUpStart: iso(w.runUpStart),
              buyUntil: iso(w.buyUntil),
              sellFrom: iso(w.sellFrom),
              sellTo: iso(w.sellTo),
            };
          }),
        );
      },

      "/predictions": {
        GET: (req) => {
          if (!canRead(req, ctx.config)) return denied();
          const realm = realmOf(req);
          if (!realm) return error(400, "realm ist ungültig");
          const action = new URL(req.url).searchParams.get("action");
          if (action !== null && !ACTIONS.has(action as Action)) return error(400, "action ist ungültig");
          const predictions = predictionsFor(ctx, realm, now()).filter((p) => !action || p.action === action);
          return Response.json({ realm, generatedAt: new Date(now()).toISOString(), predictions });
        },
      },

      "/items/:id/predictions": {
        GET: (req) => {
          if (!canRead(req, ctx.config)) return denied();
          const realm = realmOf(req);
          const itemId = Number(req.params.id);
          if (!realm) return error(400, "realm ist ungültig");
          if (!Number.isInteger(itemId) || itemId <= 0) return error(400, "Item-ID ist ungültig");
          const predictions = predictionsFor(ctx, realm, now()).filter((p) => p.itemId === itemId);
          return Response.json({ realm, itemId, predictions });
        },
      },

      "/assessments": {
        GET: (req) => {
          if (!canRead(req, ctx.config)) return denied();
          const realm = realmOf(req);
          if (!realm) return error(400, "realm ist ungültig");
          const direction = new URL(req.url).searchParams.get("direction");
          if (direction !== null && !DIRECTIONS.has(direction)) return error(400, "direction ist ungültig");
          const list = ctx.repo.assessments(realm).filter((a) => !direction || a.direction === direction);
          const names = ctx.repo.itemNames(list.map((a) => a.itemId));
          return Response.json({
            realm,
            assessments: list.map((a) => ({ ...a, itemName: names.get(a.itemId) ?? null })),
          });
        },
      },

      "/brief": (req) => {
        if (!canRead(req, ctx.config)) return denied();
        const brief = ctx.repo.latestBrief();
        return brief ? Response.json(brief) : error(404, "Noch kein Lagebericht. Erst bun run analyze laufen lassen.");
      },

      "/alerts": {
        GET: (req) => {
          if (!canRead(req, ctx.config)) return denied();
          const realm = realmOf(req);
          if (!realm) return error(400, "realm ist ungültig");
          const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 50) || 50));
          return Response.json({ realm, alerts: ctx.repo.recentAlerts(realm, limit) });
        },
      },

      "/scans": {
        POST: async (req) => {
          if (!ctx.config.ingestToken) return error(503, "INGEST_TOKEN ist nicht gesetzt, Uploads sind deaktiviert");
          if (!authorized(req, ctx.config.ingestToken)) return error(401, "Token fehlt oder ist falsch");
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return error(400, "Body ist kein gültiges JSON");
          }
          const scan = parseScan(body);
          if (typeof scan === "string") return error(400, scan);
          const stored = ctx.repo.insertScan(scan.realm, scan.source, scan.scannedAt * 1000, scan.items);
          if (ctx.onScan) queueMicrotask(() => void ctx.onScan?.());
          return Response.json({ stored });
        },
      },

      "/stream": {
        GET: (req, server) => {
          if (!canRead(req, ctx.config)) return denied();
          const realm = realmOf(req);
          if (!realm) return error(400, "realm ist ungültig");
          server.timeout(req, 0); // SSE-Verbindung offen halten
          return ctx.hub.stream(realm);
        },
      },

      "/export/addon.lua": {
        GET: (req) => {
          if (!canRead(req, ctx.config)) return denied();
          const realm = realmOf(req);
          if (!realm) return error(400, "realm ist ungültig");
          const t = now();
          return new Response(toAddonLua(predictionsFor(ctx, realm, t), { realm, generatedAt: t }), {
            headers: { "content-type": "text/x-lua; charset=utf-8" },
          });
        },
      },
    },
    fetch: () => error(404, "nicht gefunden"),
  });
}
