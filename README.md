<img src="assets/icon.svg" width="64" height="64" alt="">

# wow-ah-prediction

AH-Prognosen für **WoW Forever**. Claude recherchiert im Netz, was in den nächsten Wochen kommt
(Raids, Patches, Berufe, Marktberichte), und bewertet danach jedes Item aus deinen AH-Scans:
steigt, fällt oder bleibt gleich, um wie viel, wie sicher, und wann man kaufen oder verkaufen sollte.

```
AH-Scan (alle Items) ─► Recherche mit Websuche ─► Bewertung pro Item ─► kaufen / halten / verkaufen
                         Lagebericht + Quellen      40 Items pro Anfrage    Tooltip, Discord, /stream
```

Ohne API-Key läuft der Server mit Handregeln aus `knowledge/forever/` (Event-Kalender,
Bedarfsregeln, Rezeptgraph). Sobald die KI ein Item bewertet hat, zählt ihre Bewertung.

## Der Kreislauf

```
 Spiel                         Companion (PC)                   Server
 ─────                         ──────────────                   ──────
 /wahp scan am AH
 /reload → SavedVariables ───► liest neue Scans, lädt hoch ───► POST /scans → Engine → Alerts (Discord, /stream)
 Tooltip / /wahp list  ◄────── schreibt Data.lua ◄──────────── GET /export/addon.lua        ▲
 (nach dem nächsten /reload)                                                                 │
                                                       bun run analyze (Claude) ─────────────┘
```

Addons haben im Spiel kein Netzwerk. WoW schreibt SavedVariables nur beim `/reload` oder Logout
und liest Addon-Dateien nur beim Laden. Live sind deshalb nur Discord und `/stream`, im Spiel
kommen neue Prognosen mit dem nächsten `/reload` an.

## Server starten

```sh
bun install
cp .env.example .env   # INGEST_TOKEN setzen, optional DISCORD_WEBHOOK_URL
bun run dev            # oder: bun start
bun test               # alle Tests, inkl. Addon-Tests mit lua5.1 (falls installiert)
bun run typecheck
```

Die Datenbank ist SQLite (`bun:sqlite`) unter `data/wahp.sqlite`.

### Auf Coolify betreiben

Coolify baut das Image aus dem `Dockerfile` (Bun 1.3.14, läuft als Nutzer `bun`, ohne Build-Schritt).
Der Code muss dafür in einem Git-Repo liegen, das Coolify lesen kann.

1. **Neue Ressource → Application → Repo auswählen.** Als Build Pack **Dockerfile** einstellen.
2. **Ports Exposes** auf `3000` setzen und die Domain eintragen (z. B. `https://ah.example.com`). Das Zertifikat holt Coolify.
3. **Persistent Storage:** ein Volume mit Ziel `/app/data` anlegen, dort liegt die Datenbank. Ein Volume,
   kein Host-Ordner, sonst fehlen dem Nutzer `bun` die Schreibrechte. Ohne Volume ist nach jedem Deploy alles weg.
4. **Environment Variables:**
   - `INGEST_TOKEN`: neu und lang, z. B. `openssl rand -hex 24`.
   - `READ_TOKEN`: ohne ihn kann jeder mit der URL deine Prognosen und den Lagebericht lesen.
   - `OPENROUTER_API_KEY` (oder `ANTHROPIC_API_KEY`) und `DISCORD_WEBHOOK_URL`.
   - Der Rest wie in `.env.example`, z. B. `AI_BUDGET_USD`.
5. **Health Check:** Er steckt im Dockerfile (`/health`), in Coolify ist nichts einzustellen.
6. **KI-Analyse:** `AI_INTERVAL_HOURS=24` lässt den Server sie selbst starten. Alternativ unter
   **Scheduled Tasks** `bun run analyze` eintragen, z. B. täglich `0 6 * * *`. Von Hand geht es im
   Terminal der App: `bun run analyze --dry-run`.

Danach in der `companion.json` `serverUrl` auf die Domain und `token` auf den `INGEST_TOKEN` aus
Coolify setzen. Der Companion schickt den Token auch beim Abholen der Data.lua mit. Den
`READ_TOKEN` brauchst du für den Browser (`https://ah.example.com/brief?token=…`) und für `/stream`.
Nur eine Instanz laufen lassen (SQLite). Den lokalen Server dann ausmachen, sonst posten beide in Discord.

## Addon installieren

`addon/WowAhPrediction` in den AddOns-Ordner kopieren, z. B.
`World of Warcraft\_forever_\Interface\AddOns\WowAhPrediction`.

- `/wahp scan`: Komplett-Scan, das Auktionshaus muss offen sein (Blizzard erlaubt das alle 15 Minuten)
- `/wahp list`: Aktuelle Kauf- und Verkaufssignale im Chat
- `/wahp status`: Alter der Prognose-Daten und letzter Scan
- Tooltip: Empfehlung, Zeitfenster und Preise, mit Shift auch die Begründung

Die TOC nutzt `## Interface: 16001` (Forever-Beta 1.60.1). Wenn das Addon als veraltet gilt:
im Spiel `/dump select(4, GetBuildInfo())` und die Zahl in der TOC anpassen.

Welche AH-Scan-API der Forever-Client hat, ist nicht dokumentiert. Das Addon erkennt zur Laufzeit
`C_AuctionHouse.ReplicateItems` oder das alte `QueryAuctionItems` mit getAll. Beides ist gegen
einen nachgebauten Client getestet (`addon/tests/`), aber noch nicht im echten Spiel.

## Companion

```sh
bun run build:companion        # → dist/wahp-companion.exe (Windows, eine Datei, ohne Installation)
bun run companion              # oder direkt mit Bun starten
```

Beim ersten Start legt er eine `companion.json` als Vorlage an:

```json
{
  "wowDir": "C:\\Program Files (x86)\\World of Warcraft",
  "serverUrl": "http://localhost:3000",
  "token": "dein INGEST_TOKEN vom Server"
}
```

`wowDir` darf der WoW-Hauptordner sein, der Companion sucht den Flavor-Ordner mit dem Addon selbst
(`_forever_` zuerst). Optional: `realm`, `pollSeconds` (15), `refreshMinutes` (5).
Mit `--once` macht er einen einzigen Durchlauf.

Der Realm-Key wird aus Region, Realm und Fraktion gebaut (z. B. `eu-everlook-alliance`), weil jede
Fraktion ihr eigenes AH hat. Scans am neutralen AH (Beutebucht, Gadgetzan) kann das Addon noch
nicht unterscheiden.

## KI-Analyse (Claude)

```sh
# ANTHROPIC_API_KEY oder OPENROUTER_API_KEY in die .env eintragen, dann:
bun run analyze --dry-run                 # nur zählen und Kosten schätzen
bun run analyze --limit 100               # erstmal die 100 umsatzstärksten Items
bun run analyze                           # alles, was fällig ist
bun run analyze --new-brief --all         # neu recherchieren und alles neu bewerten
```

Ein Lauf hat zwei Schritte:

1. **Recherche:** Claude sucht selbst im Netz (Blizzard-News, Patchnotes, Wowhead, Reddit …) und
   schreibt einen Lagebericht mit Quellen: Zeitplan, Bossmechaniken, Berufsänderungen,
   Angebotsseite, Marktberichte. Der Bericht wird gespeichert und bis zu `AI_BRIEF_MAX_AGE_HOURS`
   (24 h) wiederverwendet. Ansehen: `GET /brief`.
2. **Bewertung:** Alle Items aus dem neuesten Scan (ohne graue), die umsatzstärksten zuerst, in
   Blöcken von `AI_CHUNK_SIZE` (40). Claude bekommt den Lagebericht plus Name, Kategorie, Preis,
   Trend zur Vorwoche und Menge und antwortet in einem festen, typisierten Schema
   (Zod + Structured Outputs): Richtung, erwartete Änderung in %, Sicherheit, Kauf-/Verkaufsfenster,
   Treiber, Begründung. Ansehen: `GET /assessments?direction=up`.

Danach wird nur neu bewertet, was fällig ist: neue Items, Bewertungen älter als
`AI_REASSESS_HOURS` (72 h) oder Preissprünge über 25 %.

**Kosten:** Standard ist Claude Opus 5.5 (`AI_MODEL`). Grob 4 bis 5 $ pro 1000 Items plus etwa
1 $ für die Recherche. `--dry-run` schätzt vorher. `AI_BUDGET_USD` (10 $) bricht einen Lauf ab,
der Rest kommt beim nächsten Mal dran. Günstiger geht es mit `AI_MODEL=claude-sonnet-5-5` (etwa
die Hälfte) oder `claude-haiku-5-5` (Bruchteil, aber schwächer im Abwägen).

Automatisch: `AI_INTERVAL_HOURS=24` lässt den Server selbst analysieren. Lehnt das Modell eine
Anfrage ab, springt serverseitig ein Ersatzmodell ein (`fallbacks: "default"`, nur bei Anthropic direkt).

### Über OpenRouter

Statt `ANTHROPIC_API_KEY` geht auch `OPENROUTER_API_KEY`. Ist nur der gesetzt, läuft alles über
OpenRouter, sonst mit `AI_PROVIDER=openrouter` erzwingen. `AI_MODEL` bleibt in der
Anthropic-Schreibweise, aus `claude-opus-5-5` wird automatisch `anthropic/claude-opus-5.5`.

OpenRouter spricht das Anthropic-Format (`/api/v1/messages`), der Code bleibt derselbe. Unterschiede:

- Nur die Rechenzentren **Anthropic** und **Claude Platform on AWS**. Nur dort gibt es die native
  Websuche, bei Bedrock fehlt zusätzlich die strukturierte Ausgabe. Gleicher Preis wie bei
  Anthropic direkt, OpenRouter nimmt eine Gebühr beim Aufladen.
- Recherche nur mit Websuche, ohne Web-Fetch (das Anthropic-Werkzeug reicht OpenRouter nicht sicher durch).
- Kein Ersatzmodell bei Ablehnung. Lehnt Claude einen Block ab, fehlt der eben.
- Die Kosten kommen exakt von OpenRouter (`usage.cost`), das Budget rechnet damit. Wo sie
  fehlen, wird wie bei Anthropic aus den Tokens geschätzt.
- Ein zusätzlich gesetzter `ANTHROPIC_API_KEY` wird nie an OpenRouter geschickt.

## API

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/health` | Lebenszeichen für den Health Check, immer ohne Token |
| GET | `/predictions?realm=eu&action=buy` | Alle aktuellen Prognosen, optional nach Aktion gefiltert |
| GET | `/items/:id/predictions?realm=eu` | Prognosen für ein Item |
| GET | `/events` | Events mit Status und Kauf-/Verkaufsfenstern |
| GET | `/assessments?realm=eu&direction=up` | KI-Bewertungen pro Item (up, down, flat) |
| GET | `/brief` | Letzter Lagebericht der KI-Recherche mit Quellen |
| GET | `/alerts?realm=eu&limit=50` | Letzte Alerts |
| GET | `/stream?realm=eu` | **Live**: Server-Sent Events, neue Alerts sofort |
| GET | `/export/addon.lua?realm=eu` | `Data.lua` fürs Addon (Tabelle `WAHP_DATA`) |
| POST | `/scans` | AH-Scan hochladen (`Authorization: Bearer <INGEST_TOKEN>`) |

Scan-Format (Preise in Kupfer pro Stück, `scannedAt` in Unix-Sekunden wie WoWs `time()`).
`marketPrice` ist optional (Ø der günstigsten 15 % der Menge) und wird statt `minBuyout`
verwendet, damit ein einzelnes verramschtes Angebot die Prognose nicht verzerrt. `name`,
`quality` (0 = grau bis 5 = legendär) und `category` sind optional und helfen der KI:

```json
{ "realm": "eu-everlook-alliance", "source": "companion", "scannedAt": 1794740651,
  "items": [{ "itemId": 13466, "minBuyout": 100, "marketPrice": 3743, "quantity": 101,
              "name": "Pestblüte", "quality": 1, "category": "Handwerkswaren/Kräuter" }] }
```

Alerts gehen raus, wenn eine Empfehlung auf **kaufen** oder **verkaufen** wechselt: per SSE und,
falls `DISCORD_WEBHOOK_URL` gesetzt ist, auch in Discord. Die Engine läuft alle
`ENGINE_INTERVAL_MIN` Minuten und direkt nach jedem Scan-Upload.

## Wissensbasis pflegen (Handregeln)

Die Handregeln greifen für Items, die die KI (noch) nicht bewertet hat, und ihre Termine gehen als
„bereits bekannt“ in die Recherche. Alles liegt in `knowledge/forever/` und wird beim Start validiert:

- `events.ts`: Was kommt wann (`date` als YYYY-MM-DD)
- `rules.ts`: Welches Event treibt welche Items/Tags um wie viel (`impact` 0.5 = +50 % zum Peak) und wie sicher (`confidence`)
- `recipes.ts`: Rezepte. Die Engine leitet daraus die Nachfrage nach den Mats selbst ab.
- `items.ts`: Items mit Tags wie `raid-consumable`

Neue Boss-Mechanik bekannt (z. B. Schattenschaden)? Eine Regel in `rules.ts` reicht, die Kräuter
dahinter rechnet die Engine selbst aus.

> Item-IDs und Rezepte sind aktuell Classic-1.12-Daten und noch nicht gegen Forever geprüft.
> Ungeprüfte Rezepte senken die angezeigte Sicherheit automatisch.

## Wie die Prognose rechnet

**KI-Bewertung:** Aus „steigt um 50 % bis zum 8.12., 60 % sicher“ wird *kaufen*, wenn der
Gewinn nach 5 % AH-Gebühr mindestens `MIN_UPSIDE` beträgt und die Sicherheit mindestens
`MIN_CONFIDENCE`. Bezugspunkt ist der Preis bei der Bewertung: Ist er seitdem schon gestiegen,
schrumpft der Rest-Gewinn. Im Verkaufsfenster wird daraus *verkaufen*. Bei erwartetem
Preisverfall heißt es *verkaufen* (Bestände loswerden) oder *meiden*. „flat“ erscheint nicht im
Tooltip.

**Handregeln:**

1. **Nachfrage:** Regeln treffen Items direkt. Reagenzien erben den Aufschlag ihrer Produkte mit Faktor 0.8.
   Mehrere Abnehmer zählen mit abnehmendem Gewicht (1, ½, ¼, …).
2. **Preiskurve pro Event:** Run-up ab 21 Tage vorher, Peak 3 Tage nach Release, danach Abklingen
   über 28 Tage auf 35 % des Aufschlags (Muster aus Classic 2019/20, pro Event überschreibbar).
3. **Normalpreis:** Median der Scans aus der Woche vor dem Run-up. Fehlt der, wird er aus dem
   aktuellen Preis zurückgerechnet.
4. **Empfehlung:** Kaufen, wenn der erwartete Gewinn nach 5 % AH-Gebühr mindestens `MIN_UPSIDE`
   beträgt. Wenn Spekulanten den Preis schon hochgetrieben haben, wird daraus „beobachten“.

Jede Prognose landet in `prediction_log`, damit man später nachmessen kann, wie gut sie war.

## Nächste Schritte

- Im echten Forever-Client testen: Interface-Nummer, welche Scan-API, Laufzeit bei vollem Mega-Realm-AH
- Erster echter KI-Lauf mit `--limit 100`, Lagebericht (`/brief`) und Bewertungen gegenlesen
- Treffsicherheit messen: `prediction_log` gegen die späteren Scan-Preise auswerten
- Message Batches API für die Bewertung (halber Preis, dafür Ergebnisse erst nach Minuten bis Stunden)
- Testen, ob die Blizzard-API AH-Daten für Forever liefert (dann bräuchte es keine Ingame-Scans)
