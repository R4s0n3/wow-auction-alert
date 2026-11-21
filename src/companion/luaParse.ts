// Parser für WoW-SavedVariables: Zuweisungen von Lua-Literalen (Tabellen,
// Strings, Zahlen, Booleans, nil) plus Kommentare. Mehr schreibt WoW nicht.

export type LuaValue = string | number | boolean | null | LuaValue[] | { [key: string]: LuaValue };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34, "'": 39, "\n": 10 };

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  fail(message: string): never {
    const line = this.src.slice(0, this.pos).split("\n").length;
    throw new Error(`Lua-Parse-Fehler in Zeile ${line}: ${message}`);
  }

  private skip(): void {
    for (;;) {
      const rest = this.src.slice(this.pos, this.pos + 4);
      if (/^\s/.test(rest)) {
        this.pos++;
      } else if (rest.startsWith("--[[")) {
        const end = this.src.indexOf("]]", this.pos + 4);
        this.pos = end === -1 ? this.src.length : end + 2;
      } else if (rest.startsWith("--")) {
        const end = this.src.indexOf("\n", this.pos);
        this.pos = end === -1 ? this.src.length : end + 1;
      } else {
        return;
      }
    }
  }

  private peek(): string {
    this.skip();
    return this.src[this.pos] ?? "";
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) this.fail(`"${ch}" erwartet, gefunden "${this.src[this.pos] ?? "Dateiende"}"`);
    this.pos++;
  }

  private identifier(): string | null {
    this.skip();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos, this.pos + 256));
    if (!m) return null;
    this.pos += m[0].length;
    return m[0];
  }

  atEnd(): boolean {
    this.skip();
    return this.pos >= this.src.length;
  }

  assignment(): [string, LuaValue] {
    const name = this.identifier();
    if (!name) this.fail("Variablenname erwartet");
    this.expect("=");
    const value = this.value();
    if (this.peek() === ";") this.pos++;
    return [name, value];
  }

  value(): LuaValue {
    const ch = this.peek();
    if (ch === "{") return this.table();
    if (ch === '"' || ch === "'") return this.string();
    if (ch === "-" || ch === "." || /\d/.test(ch)) return this.number();
    const word = this.identifier();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "nil") return null;
    return this.fail(`unerwartetes "${word ?? ch}"`);
  }

  private number(): number {
    const m = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf|nan)/.exec(this.src.slice(this.pos, this.pos + 64));
    if (!m) this.fail("Zahl erwartet");
    this.pos += m[0].length;
    const text = m[0];
    if (text.endsWith("inf")) return text.startsWith("-") ? -Infinity : Infinity;
    if (text.endsWith("nan")) return Number.NaN;
    const hex = /^(-?)0[xX](.+)$/.exec(text);
    return hex ? (hex[1] ? -1 : 1) * Number.parseInt(hex[2]!, 16) : Number(text);
  }

  // Lua-Strings sind Bytes: \ddd-Escapes werden als Bytes gesammelt und am Ende als UTF-8 gelesen.
  private string(): string {
    const quote = this.src[this.pos]!;
    this.pos++;
    const bytes: number[] = [];
    for (;;) {
      const cp = this.src.codePointAt(this.pos);
      if (cp === undefined) this.fail("String nicht geschlossen");
      const ch = String.fromCodePoint(cp);
      this.pos += ch.length;
      if (ch === quote) break;
      if (ch !== "\\") {
        for (const b of encoder.encode(ch)) bytes.push(b);
        continue;
      }
      const next = this.src[this.pos] ?? "";
      const digits = /^\d{1,3}/.exec(this.src.slice(this.pos, this.pos + 3));
      if (digits) {
        bytes.push(Number(digits[0]) & 0xff);
        this.pos += digits[0].length;
      } else if (next in ESCAPES) {
        bytes.push(ESCAPES[next]!);
        this.pos++;
      } else {
        this.fail(`unbekanntes Escape "\\${next}"`);
      }
    }
    return decoder.decode(new Uint8Array(bytes));
  }

  private table(): LuaValue {
    this.expect("{");
    const array: LuaValue[] = [];
    const hash = new Map<string | number, LuaValue>();
    for (;;) {
      const ch = this.peek();
      if (ch === "}") {
        this.pos++;
        break;
      }
      if (ch === "[") {
        this.pos++;
        const key = this.value();
        if (typeof key !== "string" && typeof key !== "number") this.fail("Tabellen-Key muss String oder Zahl sein");
        this.expect("]");
        this.expect("=");
        hash.set(key, this.value());
      } else {
        const save = this.pos;
        const name = this.identifier();
        if (name && this.peek() === "=" && this.src[this.pos + 1] !== "=") {
          this.pos++;
          hash.set(name, this.value());
        } else {
          this.pos = save;
          array.push(this.value());
        }
      }
      const sep = this.peek();
      if (sep === "," || sep === ";") this.pos++;
      else if (sep !== "}") this.fail(`"," oder "}" erwartet`);
    }
    return toJs(array, hash);
  }
}

// Reine Sequenzen 1..n werden JS-Arrays, alles andere Objekte mit String-Keys.
function toJs(array: LuaValue[], hash: Map<string | number, LuaValue>): LuaValue {
  for (const [key, value] of [...hash]) {
    if (typeof key === "number" && key === array.length + 1) {
      array.push(value);
      hash.delete(key);
    }
  }
  if (hash.size === 0) return array;
  const obj: Record<string, LuaValue> = {};
  array.forEach((v, i) => (obj[String(i + 1)] = v));
  for (const [key, value] of hash) obj[String(key)] = value;
  return obj;
}

/** Parst eine SavedVariables-Datei in { Variablenname: Wert }. */
export function parseSavedVariables(src: string): Record<string, LuaValue> {
  const parser = new Parser(src.replace(/^﻿/, ""));
  const out: Record<string, LuaValue> = {};
  while (!parser.atEnd()) {
    const [name, value] = parser.assignment();
    out[name] = value;
  }
  return out;
}
