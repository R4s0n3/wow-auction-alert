-- Aufruf (Lua 5.1, wie im Client):
--   lua5.1 addon/tests/run.lua test                   Unit-Tests
--   lua5.1 addon/tests/run.lua scan <sv-datei>        Scan simulieren, SavedVariables schreiben
--   lua5.1 addon/tests/run.lua tooltip <data.lua> <id> Tooltip-Zeilen für ein Item ausgeben
local here = arg[0]:match("^(.*)/[^/]*$") or "."
package.path = here .. "/?.lua;" .. package.path
local ADDON_DIR = here .. "/../WowAhPrediction"

local function fresh(opts)
  package.loaded.harness = nil
  local H = require("harness")
  local ns = H.loadAddon(ADDON_DIR, opts)
  return H, ns
end

local function openAhAndScan(H, ns)
  H.fire("AUCTION_HOUSE_SHOW")
  ns.startScan()
  H.fire(H.api == "modern" and "REPLICATE_ITEM_LIST_UPDATE" or "AUCTION_ITEM_LIST_UPDATE")
  H.runTimers(0)
end

-- 100 Pestblüte zu 40s, eine verramschte zu 1s, 20 Schwarzer Lotus.
local SAMPLE = {
  { 13466, 20, 20 * 4000, "Pestblüte" },
  { 13466, 20, 20 * 4200, "Pestblüte" },
  { 13466, 60, 60 * 4500, "Pestblüte" },
  { 13466, 1, 100, "Pestblüte" },
  { 13468, 1, 950000, "Schwarzer Lotus" },
  { 13468, 1, 990000, "Schwarzer Lotus" },
  { 2589, 20, 0, "Leinenstoff" }, -- nur Gebot, kein Sofortkauf: wird ignoriert
}

local tests = {}
local function test(name, fn) tests[#tests + 1] = { name, fn } end
local function eq(a, b, msg)
  if a ~= b then error((msg or "") .. ": erwartet " .. tostring(b) .. ", bekommen " .. tostring(a), 2) end
end
local function contains(s, part)
  if not string.find(s, part, 1, true) then error(("%q enthält nicht %q"):format(s, part), 2) end
end

test("summarize: Mindestpreis, Marktpreis über die günstigsten 15 %, Menge", function()
  local _, ns = fresh()
  local agg = {}
  for _, a in ipairs(SAMPLE) do ns.addAuction(agg, a[1], a[2], a[3]) end
  local out, n = ns.summarize(agg)
  eq(n, 2, "Items")
  eq(out[13466].min, 100, "min")
  eq(out[13466].q, 101, "Menge")
  -- 15 % von 101 = 15.15 Stück: 1 × 100 + 14.15 × 4000
  eq(out[13466].mkt, math.floor((100 + 14.15 * 4000) / 15.15 + 0.5), "mkt")
  eq(out[13468].mkt, 950000, "Lotus mkt")
  eq(out[2589], nil, "Gebot ohne Buyout")
end)

for _, api in ipairs({ "legacy", "modern" }) do
  test("Komplett-Scan über die " .. api .. "-API landet in WAHP_DB", function()
    local H, ns = fresh({ api = api })
    H.auctions = SAMPLE
    openAhAndScan(H, ns)
    local scan = WAHP_DB.scans[1]
    assert(scan, "kein Scan gespeichert")
    eq(scan.realm, "Everlook")
    eq(scan.faction, "Alliance")
    eq(scan.region, 3)
    eq(scan.auctions, #SAMPLE)
    eq(scan.itemCount, 2)
    eq(scan.items[13468].min, 950000)
    if api == "legacy" then eq(H.queried[7], true, "getAll") end
    contains(H.chat[#H.chat], "Scan fertig")
    -- Item-Infos landen global, nicht im Scan; Gebots-Auktionen ohne Buyout nicht
    eq(WAHP_DB.itemInfo[13466].n, "Pestblüte")
    eq(WAHP_DB.itemInfo[13466].ql, 1)
    eq(WAHP_DB.itemInfo[13466].c, "Handwerkswaren/Kräuter")
    eq(WAHP_DB.itemInfo[13466].cls, 7, "Itemklasse")
    eq(WAHP_DB.itemInfo[13466].sub, 9, "Unterklasse")
    eq(WAHP_DB.itemInfo[2589], nil, "nur Gebot")
  end)
end

test("Scan ohne offenes AH wird abgelehnt", function()
  local H, ns = fresh()
  ns.startScan()
  contains(H.chat[#H.chat], "Öffne zuerst das Auktionshaus")
  eq(#WAHP_DB.scans, 0)
end)

test("15-Minuten-Sperre wird respektiert", function()
  local H, ns = fresh()
  H.canQueryAll = false
  H.fire("AUCTION_HOUSE_SHOW")
  ns.startScan()
  contains(H.chat[#H.chat], "nur alle 15 Minuten")
end)

test("AH schließen bricht den Scan ab", function()
  local H, ns = fresh()
  H.auctions = SAMPLE
  H.fire("AUCTION_HOUSE_SHOW")
  ns.startScan()
  H.fire("AUCTION_HOUSE_CLOSED")
  H.fire("AUCTION_ITEM_LIST_UPDATE")
  H.runTimers(0)
  eq(#WAHP_DB.scans, 0)
  contains(H.chat[#H.chat], "abgebrochen")
end)

test("es werden höchstens MAX_SCANS Scans aufgehoben", function()
  local H, ns = fresh()
  H.auctions = SAMPLE
  for _ = 1, ns.MAX_SCANS + 2 do openAhAndScan(H, ns) end
  eq(#WAHP_DB.scans, ns.MAX_SCANS)
end)

local PRED = {
  action = "buy", name = "Pestblüte", event = "Raid-Welle 1", eventDate = "2026-12-09",
  impact = 0.48, confidence = 0.51, netUpside = 0.41, current = 4250, peak = 63000,
  buyUntil = "2026-12-05", sellFrom = "2026-12-08", sellTo = "2026-12-19",
  why = "Raid-Welle 1 → Elixier des Mungos → Pestblüte: Gilden stocken ein", cat = "trade",
}

test("Tooltip zeigt Empfehlung, Preise und Begründung erst mit Shift", function()
  local H, ns = fresh()
  WAHP_DATA = { realm = "eu", generatedAt = os.time(), items = { [13466] = { PRED } } }
  local lines = H.hoverItem(13466)
  contains(lines[2][1], "KAUFEN")
  contains(lines[2][1], "bis 05.12. · Peak +48 % · 51 % sicher")
  contains(lines[3][1], "Jetzt 0g 42s 50c, Peak ~6g 30s 0c")
  eq(lines[4][1], "Raid-Welle 1")
  eq(lines[5][1], "(Shift: Begründung)")

  H.shift = true
  lines = H.hoverItem(13466)
  contains(lines[5][1], "Warum: Raid-Welle 1 → Elixier des Mungos")
end)

test("Tooltip warnt bei alten Daten und bleibt bei unbekannten Items leer", function()
  local H = fresh()
  WAHP_DATA = { realm = "eu", generatedAt = os.time() - 30 * 3600, items = { [13466] = { PRED } } }
  local lines = H.hoverItem(13466)
  contains(lines[#lines][1], "Prognose ist 30 h alt")
  eq(#H.hoverItem(99999), 0)
end)

test("Tooltip für KI-Prognose mit erwartetem Preisverfall", function()
  local H = fresh()
  local falling = {
    action = "sell", src = "ai", name = "Pestblüte", event = "Mehr Spieler auf 60", impact = -0.3,
    confidence = 0.6, netUpside = -0.33, current = 4000, peak = 2800, sellTo = "2026-12-01",
    why = "Nach dem Launch farmen immer mehr Spieler Kräuter.",
  }
  WAHP_DATA = { realm = "eu", generatedAt = os.time(), items = { [13466] = { falling } } }
  local lines = H.hoverItem(13466)
  contains(lines[2][1], "VERKAUFEN")
  contains(lines[2][1], "vorher loswerden · Tief -30 % · 60 % sicher")
  contains(lines[3][1], "Jetzt 0g 40s 0c, Tief ~0g 28s 0c")
  eq(lines[4][1], "KI: Mehr Spieler auf 60")
  H.shift = true
  lines = H.hoverItem(13466)
  eq(lines[5][1], "Warum: Nach dem Launch farmen immer mehr Spieler Kräuter.")
end)

test("/wahp list sortiert Verkaufen vor Kaufen", function()
  local H = fresh()
  local sell = { action = "sell", name = "Traumblatt", netUpside = 0.1, sellTo = "2026-12-19" }
  WAHP_DATA = { realm = "eu", generatedAt = os.time(), items = { [13466] = { PRED }, [13463] = { sell } } }
  SlashCmdList.WAHP("list")
  contains(H.chat[1], "2 Signale für eu")
  contains(H.chat[2], "Traumblatt")
  contains(H.chat[3], "Pestblüte")
end)

-- Fenster ---------------------------------------------------------------------

local LOTUS = {
  action = "sell", src = "ai", name = "Schwarzer Lotus", event = "Mehr Spieler auf 60", impact = -0.3,
  confidence = 0.7, netUpside = -0.33, current = 950000, peak = 665000, sellTo = "2026-12-05", why = "Mehr Lotus-Farmer.", cat = "trade",
}
local CRATE = {
  action = "sell", src = "ai", name = "Abgefangene Kiste", event = "Writs brechen ein", impact = -0.7,
  confidence = 0.65, netUpside = -0.72, current = 97, peak = 29, sellTo = "2026-11-28", why = "Händlerware ohne Abnehmer.", cat = "faction",
  uses = "Craftsman's Writ: Kiste",
}
local function withData()
  WAHP_DATA = { realm = "eu-alliance", generatedAt = os.time(), items = { [13466] = { PRED }, [13468] = { LOTUS }, [5] = { CRATE } } }
end

test("Fenster: /wahp öffnet, Verkaufen nach Gold sortiert, Suche, Taschen, Details", function()
  local H, ns = fresh()
  withData()
  SlashCmdList.WAHP("")
  assert(WAHPFrame and WAHPFrame:IsShown(), "Fenster offen")
  local rows = ns.ui.rows
  eq(rows[1].itemId, 13468, "Lotus (-30 % auf 95g) vor der Kiste (-70 % auf 97c)")
  eq(rows[2].itemId, 5)
  eq(rows[3]:IsShown(), false)
  contains(rows[1].badge.text, "-30 %")
  contains(rows[1].sub.text, "95g 0s 0c")
  contains(rows[1].sub.text, "66g 50s 0c")
  contains(rows[1].sub.text, "bis 05.12.")
  contains(rows[1].name.text, "Schwarzer Lotus")
  contains(rows[1].name.text, "KI")
  eq(rows[1].icon.texture, "icon-13468")
  contains(ns.ui.tabs[1].button.text, "Verkaufen")
  contains(ns.ui.tabs[1].button.text, "2")

  ns.ui.setTab("buy")
  eq(rows[1].itemId, 13466)
  contains(rows[1].badge.text, "+41 %")
  contains(rows[1].sub.text, "bis 05.12.")

  ns.ui.setTab("sell")
  ns.ui.search:SetText("lotus")
  ns.ui.search.scripts.OnTextChanged(ns.ui.search)
  eq(rows[1].itemId, 13468)
  eq(rows[2]:IsShown(), false)
  ns.ui.search:SetText("gibtsnicht")
  ns.ui.search.scripts.OnTextChanged(ns.ui.search)
  contains(ns.ui.empty.text, "Nichts gefunden")
  ns.ui.search:SetText("")
  ns.ui.search.scripts.OnTextChanged(ns.ui.search)

  H.bags = { [5] = 40 }
  ns.ui.setTab("bags")
  eq(rows[1].itemId, 5)
  contains(rows[1].sub.text, "40x")
  eq(rows[2]:IsShown(), false)

  rows[1]:Click()
  contains(ns.ui.details.why.text, "KI: Writs brechen ein")
  contains(ns.ui.details.why.text, "Händlerware ohne Abnehmer.")
  eq(ns.ui.details.link.text, "https://www.wowhead.com/forever/de/item=5")
  rows[1].scripts.OnEnter(rows[1])
  eq(GameTooltip.item, 5, "Item-Tooltip beim Drüberfahren")
  contains(ns.ui.details.why.text, "Verlangt von: Craftsman's Writ: Kiste")
end)

test("Fenster: Kategorie-Leiste filtert, Fokus ist Standard, Wahl bleibt gespeichert", function()
  local H, ns = fresh()
  WAHP_DATA = { realm = "eu-alliance", generatedAt = os.time(), items = {
    [13468] = { LOTUS }, [5] = { CRATE },
    [7] = { { action = "sell", name = "Feuerschutztrank", cat = "consumable", impact = -0.2, confidence = 0.5, current = 9000, peak = 7000 } },
    [8] = { { action = "sell", name = "Ohne Kategorie", impact = -0.4, confidence = 0.6, current = 5000, peak = 3000 } },
  } }
  SlashCmdList.WAHP("")
  local rows = ns.ui.rows
  eq(ns.uiState.cat, "focus")
  eq(rows[1].itemId, 13468, "Waren")
  eq(rows[2].itemId, 5, "Fraktion")
  eq(rows[3]:IsShown(), false, "Verbrauch und ohne Kategorie nicht im Fokus")
  contains(rows[2].name.text, "[Verfügung]")
  ns.ui.catButtons.consumable:Click()
  eq(rows[1].itemId, 7)
  eq(rows[2]:IsShown(), false)
  ns.ui.catButtons.recipe:Click()
  contains(ns.ui.empty.text, "Nichts in dieser Kategorie")
  ns.ui.catButtons.all:Click()
  eq(rows[4]:IsShown(), true, "Alle zeigt auch die ohne Kategorie")
  eq(WAHP_DB.settings.category, "all")
end)

test("Forever-Client: Itemklasse über C_Item, Münzen ohne alte globale Funktion", function()
  local H, ns = fresh()
  local instant = GetItemInfoInstant
  GetItemInfoInstant = nil
  C_Item = { GetItemInfoInstant = function(id) return instant(id) end }
  local coins = GetCoinTextureString
  GetCoinTextureString = nil
  C_CurrencyInfo = { GetCoinTextureString = function(c) return "C" .. c end }
  local ok, err = pcall(function()
    H.auctions = SAMPLE
    openAhAndScan(H, ns)
    eq(WAHP_DB.itemInfo[13466].cls, 7, "Klasse über C_Item")
    eq(ns.coinString(4250), "C4250")
    WAHP_DATA = { realm = "eu", generatedAt = os.time(), items = { [13466] = { PRED } } }
    contains(H.hoverItem(13466)[3][1], "Jetzt C4250")
  end)
  GetItemInfoInstant, C_Item, GetCoinTextureString, C_CurrencyInfo = instant, nil, coins, nil
  assert(ok, err)
end)

test("Scan-Knopf: nur am AH, scannt, lädt nach Countdown neu, danach Cooldown", function()
  local H, ns = fresh({ api = "modern" })
  H.auctions = SAMPLE
  withData()
  SlashCmdList.WAHP("")
  local b = ns.ui.scanButton
  eq(b.enabled, false, "ohne AH aus")
  contains(b.text, "am Auktionshaus")
  H.fire("AUCTION_HOUSE_SHOW")
  eq(b.enabled, true)
  eq(b.text, "AH scannen")
  b:Click()
  contains(b.text, "Scanne")
  H.fire("REPLICATE_ITEM_LIST_UPDATE")
  H.runTimers(0)
  eq(#WAHP_DB.scans, 1)
  eq(b.text, "Abbrechen (Reload in 3)")
  eq(H.reloads, nil, "noch nicht")
  H.runTimers() -- Countdown läuft ab
  eq(H.reloads, 1)
  ns.ui.updateFooter()
  eq(b.enabled, false)
  eq(b.text, "Scan in 15 Min.")
end)

test("Scan-Knopf: Abbrechen verhindert den Reload, danach per Knopf neu laden", function()
  local H, ns = fresh({ api = "modern" })
  H.auctions = SAMPLE
  H.fire("AUCTION_HOUSE_SHOW")
  assert(WAHPFrame and WAHPFrame:IsShown(), "Fenster öffnet sich am AH von selbst")
  local b = ns.ui.scanButton
  b:Click()
  H.fire("REPLICATE_ITEM_LIST_UPDATE")
  H.runTimers(0)
  b:Click() -- Abbrechen
  H.runTimers()
  eq(H.reloads, nil, "kein Reload nach Abbrechen")
  eq(b.text, "Jetzt neu laden")
  b:Click()
  eq(H.reloads, 1)
end)

test("/wahp scan lädt nicht von selbst neu, /wahp auto schaltet das Öffnen am AH ab", function()
  local H, ns = fresh()
  H.auctions = SAMPLE
  SlashCmdList.WAHP("auto")
  contains(H.chat[#H.chat], "aus")
  H.fire("AUCTION_HOUSE_SHOW")
  eq(WAHPFrame, nil, "Fenster bleibt zu")
  ns.startScan()
  H.fire("AUCTION_ITEM_LIST_UPDATE")
  H.runTimers()
  eq(#WAHP_DB.scans, 1)
  eq(H.reloads, nil)
  contains(H.chat[#H.chat], "Nach /reload")
end)

test("modern-API: keine Antwort vom AH bricht nach einer Minute ab", function()
  local H, ns = fresh({ api = "modern" })
  H.fire("AUCTION_HOUSE_SHOW")
  ns.startScan()
  eq(ns.isScanning(), true)
  H.runTimers() -- REPLICATE_ITEM_LIST_UPDATE kommt nie
  eq(ns.isScanning(), false)
  contains(H.chat[#H.chat], "nicht geantwortet")
end)

local mode = arg[1] or "test"
if mode == "test" then
  local failed = 0
  for _, t in ipairs(tests) do
    WAHP_DATA, WAHP_DB, WAHPFrame, WAHPScroll = nil, nil, nil, nil
    local ok, err = pcall(t[2])
    print((ok and "ok   " or "FAIL ") .. t[1] .. (ok and "" or ("\n     " .. tostring(err))))
    if not ok then failed = failed + 1 end
  end
  print(("%d/%d Lua-Tests ok"):format(#tests - failed, #tests))
  os.exit(failed == 0 and 0 or 1)
elseif mode == "scan" then
  local H, ns = fresh()
  H.auctions = SAMPLE
  openAhAndScan(H, ns)
  H.writeSavedVariables(assert(arg[2], "Pfad fehlt"), "WAHP_DB", WAHP_DB)
elseif mode == "tooltip" then
  local H = fresh({ data = assert(arg[2], "Data.lua fehlt") })
  for _, l in ipairs(H.hoverItem(tonumber(arg[3]))) do print(l[1]) end
else
  error("unbekannter Modus " .. mode)
end
