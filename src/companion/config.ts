import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface CompanionConfig {
  /** WoW-Hauptordner oder direkt der Flavor-Ordner (z. B. ...\World of Warcraft\_forever_) */
  wowDir: string;
  serverUrl: string;
  token: string;
  /** Optional: Realm-Key erzwingen, sonst aus dem letzten Scan */
  realm?: string;
  /** Wie oft auf neue SavedVariables geprüft wird */
  pollSeconds: number;
  /** Wie oft die Data.lua neu geholt wird */
  refreshMinutes: number;
  /** Datei, in der sich der Companion merkt, was schon hochgeladen ist */
  statePath: string;
}

export const CONFIG_FILE = "companion.json";

/**
 * Sucht die Config in dieser Reihenfolge: --config, WAHP_COMPANION_CONFIG,
 * aktueller Ordner, neben der .exe.
 */
export function findConfigPath(argv: string[], env = process.env): string | null {
  const i = argv.indexOf("--config");
  const candidates = [
    i >= 0 ? argv[i + 1] : undefined,
    env.WAHP_COMPANION_CONFIG,
    join(process.cwd(), CONFIG_FILE),
    join(dirname(process.execPath), CONFIG_FILE),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

export function loadCompanionConfig(path: string): CompanionConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CompanionConfig>;
  const missing = (["wowDir", "serverUrl", "token"] as const).filter((k) => !raw[k]);
  if (missing.length > 0) throw new Error(`${path}: es fehlt ${missing.join(", ")}`);
  return {
    wowDir: raw.wowDir!,
    serverUrl: raw.serverUrl!.replace(/\/+$/, ""),
    token: raw.token!,
    realm: raw.realm,
    pollSeconds: raw.pollSeconds ?? 15,
    refreshMinutes: raw.refreshMinutes ?? 5,
    statePath: raw.statePath ? resolve(dirname(path), raw.statePath) : join(dirname(path), "companion-state.json"),
  };
}

export const EXAMPLE_CONFIG = {
  wowDir: "C:\\Program Files (x86)\\World of Warcraft",
  serverUrl: "http://localhost:3000",
  token: "dein INGEST_TOKEN vom Server",
};
