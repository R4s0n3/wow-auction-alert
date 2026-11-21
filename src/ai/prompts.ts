import type { Knowledge } from "../knowledge/types.ts";
import { formatGold } from "../format.ts";
import type { MarketItem } from "./types.ts";

export const RESEARCH_SYSTEM = `Du recherchierst für ein Werkzeug, das Preise im Auktionshaus von World of Warcraft Forever vorhersagt.
WoW Forever ist Blizzards "Classic+": Basis ist Classic 1.12, ergänzt um neue Inhalte (neue Raids wie Barrow Deeps und Hyjal Summit, geänderte Berufe und Items). Es ist am 4. November 2026 gestartet.

Dein Bericht ist später die einzige Wissensquelle für ein Modell, das tausende Items einzeln bewertet. Es kann selbst nicht suchen. Was nicht im Bericht steht, weiß es nicht, außer allgemeinem Classic-Wissen.

Was zählt, ist alles, was Angebot oder Nachfrage einzelner Items in den nächsten Wochen verschiebt:
- Termine: Raid-Öffnungen, Phasen, Patches, Events, Feiertage im Spiel, mit Datum
- Bossmechaniken und welche Consumables oder Resistenzen dafür gebraucht werden
- Berufe: neue oder geänderte Rezepte, neue Materialien, geänderte Reagenzien, Rezeptquellen
- Neue oder geänderte Items, Drops, Sets, Ruf-Belohnungen, die Materialien verbrauchen
- Angebotsseite: Änderungen an Farmgebieten, Kräuter- und Erzvorkommen, Dropchancen, Bots, Spielerzahlen, Levelfortschritt der Spieler
- Was Spieler über das AH berichten: welche Preise gerade explodieren oder einbrechen und warum
- Verkaufschancen: was gerade deutlich teurer ist als normal (Launch-Knappheit, Hype, wenige Anbieter) und absehbar fallen wird. Für Spieler mit vollen Taschen ist das die wichtigste Information.

Bevorzuge offizielle Quellen (Blizzard-News, Patchnotes, Bluetracker) und große Fan-Seiten (Wowhead, Icy Veins, warcraft.wiki.gg). Reddit und Foren sind gut für Marktbeobachtungen, aber kennzeichne sie als Community-Meinung. Datamining ist unbestätigt.

Trenne bestätigte Fakten von Gerüchten. Schreibe Datumsangaben immer als YYYY-MM-DD. Erfinde nichts: Wenn du zu einem Punkt nichts findest, sag das.`;

export function researchPrompt(today: string, knowledge: Knowledge, focusItems: MarketItem[]): string {
  const events = knowledge.events.map((e) => `- ${e.date}: ${e.name}${e.source ? ` (${e.source})` : ""}`).join("\n");
  const focus = focusItems
    .map((i) => i.name ?? `Item ${i.itemId}`)
    .slice(0, 80)
    .join(", ");
  return `Heute ist ${today}.

Bereits bekannt (von Hand gepflegt, bitte prüfen und ergänzen):
${events || "- nichts"}

Die umsatzstärksten Items in unserem Auktionshaus gerade: ${focus || "noch keine Scan-Daten"}.

Recherchiere den aktuellen Stand und schreib einen Lagebericht auf Deutsch, höchstens etwa 2500 Wörter, mit diesen Abschnitten:
1. Zeitplan der nächsten 8 Wochen (Datum, Ereignis, Quelle)
2. Raids und Mechaniken, und welche Consumables, Resistenzen und Materialien dadurch gefragt sein werden
3. Berufe, Rezepte und neue Items, die anders sind als in Classic 1.12
4. Angebotsseite (Farmen, Spielerfortschritt, Bots)
5. Was gerade am Markt passiert (Community-Berichte)
6. Verkaufschancen: welche Items oder Item-Gruppen gerade über dem Normalniveau liegen, warum, und wann sie voraussichtlich fallen
7. Offene Fragen und Unsicherheiten

Gib bei jedem Fakt die Quelle als URL an.`;
}

const QUALITY = ["Schlecht", "Gewöhnlich", "Selten", "Rar", "Episch", "Legendär", "Artefakt", "Erbstück"];

export function assessSystem(today: string, brief: string): string {
  return `Du bewertest Items im Auktionshaus von World of Warcraft Forever (Classic+, gestartet 2026-11-04). Heute ist ${today}.

Für jedes Item sagst du, wohin sich der Preis in den nächsten etwa 6 Wochen voraussichtlich bewegt, relativ zum aktuellen Preis:
- direction: "up", "down" oder "flat". "flat" ist richtig, wenn du keinen konkreten Treiber siehst. Ohne Treiber zu raten, kostet echte Spieler echtes Gold.
- changePct: erwartete Änderung in Prozent bis zum Peak (bei up, positiv, z. B. 40) oder Tief (bei down, negativ, z. B. -30). Bei flat 0.
- confidence: 0 bis 1. Etwa 0.2 = vage Vermutung, 0.5 = plausibler Treiber mit Quelle, 0.8 = bestätigter Treiber mit Termin, und der Preis hat noch nicht reagiert.
- buyBy: letzter sinnvoller Kauftag (YYYY-MM-DD) oder null.
- sellFrom / sellBy: Verkaufsfenster (YYYY-MM-DD) oder null. Bei down ist sellBy der Tag, bis zu dem man Bestände loswerden sollte.
- driver: der Treiber in wenigen Wörtern, z. B. "Onyxia 2026-12-09 → Feuerschutz".
- reason: ein bis zwei Sätze auf Deutsch, konkret. Bei flat reicht ein kurzer Satz.

Worauf es ankommt:
- Verkaufen ist genauso wichtig wie Kaufen. Liegt ein Preis jetzt klar über dem Niveau, das du nach der Launch-Phase erwartest (Knappheit, Hype, wenige Anbieter), und wird er absehbar fallen, dann down mit sellBy in den nächsten Tagen. Ein hoher Preis allein reicht nicht, es braucht einen Grund, warum er fällt.
- Nachfrage wandert über Rezepte: Wenn ein Raid Feuerschutztränke braucht, steigen auch die Materialien dafür.
- Was schon eingepreist ist, steigt nicht nochmal. Die Spalte Trend zeigt die Veränderung zur Vorwoche.
- Nach einem Launch fallen viele Rohstoffpreise, weil immer mehr Spieler Stufe 60 erreichen und farmen. Das gilt besonders für Materialien ohne Endgame-Nachfrage.
- Händlerwaren und Items mit sehr wenig Menge im AH sind schwer einzuschätzen. Dort lieber flat mit niedriger Sicherheit.
- Stütze dich auf den Lagebericht. Was dort nicht steht, darfst du aus Classic-Wissen ableiten, aber dann mit niedrigerer Sicherheit.

Gib genau einen Eintrag pro Item zurück, mit derselben itemId.

<lagebericht>
${brief}
</lagebericht>`;
}

function trend(i: MarketItem): string {
  if (i.priceWeekBefore === null || i.priceWeekBefore <= 0) return "?";
  const pct = Math.round((i.price / i.priceWeekBefore - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct} %`;
}

const clean = (s: string) => s.replace(/[|\n\r]/g, " ").trim();

export function itemsPrompt(items: MarketItem[]): string {
  const rows = items.map((i) =>
    [
      i.itemId,
      clean(i.name ?? "unbekannt"),
      i.quality === null ? "?" : (QUALITY[i.quality] ?? i.quality),
      clean(i.category ?? "?"),
      formatGold(i.price),
      i.priceWeekBefore === null ? "?" : formatGold(i.priceWeekBefore),
      trend(i),
      i.quantity,
    ].join(" | "),
  );
  return `Bewerte diese ${items.length} Items. Preise pro Stück (g = Gold, s = Silber, c = Kupfer).

itemId | Name | Qualität | Kategorie | Preis jetzt | Preis Vorwoche | Trend | Menge im AH
${rows.join("\n")}`;
}
