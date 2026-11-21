import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { CompanionConfig } from "./config.ts";
import { parseSavedVariables } from "./luaParse.ts";
import { dataLuaPath, extractScans, findGameDir, realmKey, savedVariablesFiles } from "./wow.ts";

interface State {
  /** "realmKey:scannedAt" aller schon hochgeladenen Scans */
  uploaded: string[];
  lastRealm?: string;
}

const MAX_REMEMBERED = 500;

export interface SyncResult {
  uploaded: number;
  dataWritten: boolean;
  realm: string | null;
}

type Log = (msg: string) => void;

export class Companion {
  private state: State;
  private mtimes = new Map<string, number>();
  private gameDir: string | null = null;

  constructor(
    private readonly config: CompanionConfig,
    private readonly log: Log = console.log,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.state = existsSync(config.statePath)
      ? (JSON.parse(readFileSync(config.statePath, "utf8")) as State)
      : { uploaded: [] };
  }

  private saveState(): void {
    this.state.uploaded = this.state.uploaded.slice(-MAX_REMEMBERED);
    writeAtomic(this.config.statePath, JSON.stringify(this.state, null, 2));
  }

  private requireGameDir(): string {
    this.gameDir ??= findGameDir(this.config.wowDir);
    if (!this.gameDir) {
      throw new Error(`Addon nicht gefunden unter ${this.config.wowDir}. Ist Interface/AddOns/WowAhPrediction installiert?`);
    }
    return this.gameDir;
  }

  /** Lädt neue Scans aus geänderten SavedVariables hoch. Gibt die Anzahl hochgeladener Scans zurück. */
  async uploadNewScans(force = false): Promise<number> {
    const done = new Set(this.state.uploaded);
    let uploaded = 0;
    for (const file of savedVariablesFiles(this.requireGameDir())) {
      const mtime = statSync(file).mtimeMs;
      if (!force && this.mtimes.get(file) === mtime) continue;
      this.mtimes.set(file, mtime);

      let scans;
      try {
        scans = extractScans(parseSavedVariables(readFileSync(file, "utf8")).WAHP_DB);
      } catch (err) {
        this.log(`SavedVariables nicht lesbar (${file}): ${(err as Error).message}`);
        continue;
      }
      for (const scan of scans.sort((a, b) => a.scannedAt - b.scannedAt)) {
        const realm = realmKey(scan);
        const key = `${realm}:${scan.scannedAt}`;
        if (done.has(key)) continue;
        const res = await this.fetchImpl(`${this.config.serverUrl}/scans`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.config.token}` },
          body: JSON.stringify({ realm, source: "companion", scannedAt: scan.scannedAt, items: scan.items }),
        });
        if (!res.ok) {
          this.log(`Upload abgelehnt (${res.status}): ${await res.text()}`);
          continue;
        }
        done.add(key);
        this.state.uploaded.push(key);
        this.state.lastRealm = realm;
        uploaded++;
        this.log(`Scan hochgeladen: ${realm}, ${new Date(scan.scannedAt * 1000).toLocaleString("de-DE")}, ${scan.items.length} Items`);
      }
    }
    if (uploaded > 0) this.saveState();
    return uploaded;
  }

  /** Holt die Prognosen und schreibt Data.lua, wenn sich inhaltlich etwas geändert hat. */
  async refreshData(): Promise<{ written: boolean; realm: string | null }> {
    const realm = this.config.realm ?? this.state.lastRealm ?? null;
    const query = realm ? `?realm=${encodeURIComponent(realm)}` : "";
    // Token auch beim Lesen mitschicken, falls der Server READ_TOKEN gesetzt hat
    const res = await this.fetchImpl(`${this.config.serverUrl}/export/addon.lua${query}`, {
      headers: { authorization: `Bearer ${this.config.token}` },
    });
    if (!res.ok) throw new Error(`Server antwortet beim Export mit ${res.status}`);
    const lua = await res.text();

    const target = dataLuaPath(this.requireGameDir());
    const withoutTimestamp = (s: string) => s.replace(/^\s*generatedAt = \d+,$/m, "");
    if (existsSync(target) && withoutTimestamp(readFileSync(target, "utf8")) === withoutTimestamp(lua)) {
      return { written: false, realm };
    }
    writeAtomic(target, lua);
    this.log(`Data.lua aktualisiert (${realm ?? "Standard-Realm"}). Im Spiel /reload für die neuen Prognosen.`);
    return { written: true, realm };
  }

  async syncOnce(force = false): Promise<SyncResult> {
    const uploaded = await this.uploadNewScans(force);
    const { written, realm } = await this.refreshData();
    return { uploaded, dataWritten: written, realm };
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
