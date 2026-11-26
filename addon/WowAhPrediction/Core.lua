local ADDON, ns = ...

ns.MAX_SCANS = 5
ns.STALE_HOURS = 24

ns.ACTION = {
  buy = { label = "KAUFEN", color = "ff33dd55" },
  sell = { label = "VERKAUFEN", color = "ffff5544" },
  hold = { label = "HALTEN", color = "ffffcc33" },
  avoid = { label = "MEIDEN", color = "ff999999" },
  watch = { label = "BEOBACHTEN", color = "ffaaaaaa" },
}

function ns.print(msg)
  DEFAULT_CHAT_FRAME:AddMessage("|cff9333eaAH-Prognose|r: " .. msg)
end

-- Neuere Clients (auch Forever) haben manche Funktionen nur noch in C_Item & Co.
-- Erst beim Aufruf nachschlagen, dann klappt beides.
function ns.getItemInfo(itemId)
  local fn = (C_Item and C_Item.GetItemInfo) or GetItemInfo
  if fn then return fn(itemId) end
end

function ns.coinString(copper)
  if GetCoinTextureString then return GetCoinTextureString(copper) end
  if C_CurrencyInfo and C_CurrencyInfo.GetCoinTextureString then return C_CurrencyInfo.GetCoinTextureString(copper) end
  local c = math.floor(copper or 0)
  return ("%dg %ds %dc"):format(math.floor(c / 10000), math.floor(c % 10000 / 100), c % 100)
end

-- Ansichten wie auf dem Server (Felder cat und uses in Data.lua). Fokus = Handwerkswaren und
-- Ausrüstung, die eine Verfügung verlangt. Verfügungen und Kisten selbst nur unter Fraktion.
ns.CATEGORY_FILTERS = {
  { key = "focus", label = "Fokus", test = function(p) return p.cat == "trade" or (p.cat == "gear" and p.uses ~= nil) end },
  { key = "trade", label = "Waren", test = function(p) return p.cat == "trade" end },
  { key = "faction", label = "Fraktion", test = function(p) return p.cat == "faction" or p.uses ~= nil end },
  { key = "consumable", label = "Verbrauch", test = function(p) return p.cat == "consumable" end },
  { key = "recipe", label = "Rezepte", test = function(p) return p.cat == "recipe" end },
  { key = "all", label = "Alle" },
}

-- Filterfunktion zur Ansicht, nil = alles
function ns.categoryFilter(key)
  for _, c in ipairs(ns.CATEGORY_FILTERS) do
    if c.key == key then return c.test end
  end
end

-- "2026-12-05" -> "05.12."
function ns.shortDate(iso)
  local _, m, d = string.match(iso or "", "^(%d+)-(%d+)-(%d+)$")
  if not d then return iso or "?" end
  return d .. "." .. m .. "."
end

function ns.pct(x)
  local p = math.floor((x or 0) * 100 + 0.5)
  return (p >= 0 and "+" or "") .. p .. " %"
end

function ns.predictionsFor(itemId)
  local data = WAHP_DATA
  return data and data.items and data.items[itemId]
end

function ns.dataAgeHours(now)
  local data = WAHP_DATA
  if not data or not data.generatedAt then return nil end
  return ((now or time()) - data.generatedAt) / 3600
end

local function colored(action)
  local a = ns.ACTION[action] or ns.ACTION.watch
  return ("|c%s%s|r"):format(a.color, a.label)
end
ns.colored = colored

-- Was eine Empfehlung pro Stück wert ist (Kupfer × Änderung × Sicherheit), wie auf dem Server
function ns.worth(p)
  local rel = p.action == "buy" and (p.netUpside or 0) or math.abs(p.impact or 0)
  return (p.current or 1) * math.max(0, rel) * (p.confidence or 0)
end

function ns.itemCount(itemId)
  if C_Item and C_Item.GetItemCount then return C_Item.GetItemCount(itemId, true) or 0 end
  if GetItemCount then return GetItemCount(itemId, true) or 0 end
  return 0
end

local BAG_ORDER = { sell = 1, hold = 2, avoid = 3, buy = 4, watch = 5 }

-- Listen fürs Fenster und /wahp list. tab: "sell", "buy" oder "bags" (was du besitzt),
-- query: Teil des Namens, filter: Funktion aus ns.categoryFilter (nil = alle).
-- Ergebnis: { itemId, p, count }, Wertvollstes zuerst.
function ns.collect(tab, query, filter)
  local data = WAHP_DATA
  local out = {}
  if not data or not data.items then return out end
  query = query and query ~= "" and string.lower(query) or nil
  for itemId, preds in pairs(data.items) do
    local p = preds[1]
    local catOk = p ~= nil and (not filter or filter(p))
    if p and catOk and (not query or string.find(string.lower(p.name or ""), query, 1, true)) then
      if tab == "bags" then
        local count = ns.itemCount(itemId)
        if count > 0 then out[#out + 1] = { itemId = itemId, p = p, count = count } end
      elseif p.action == tab then
        out[#out + 1] = { itemId = itemId, p = p }
      end
    end
  end
  table.sort(out, function(a, b)
    if tab == "bags" then
      local oa, ob = BAG_ORDER[a.p.action] or 9, BAG_ORDER[b.p.action] or 9
      if oa ~= ob then return oa < ob end
      return ns.worth(a.p) * a.count > ns.worth(b.p) * b.count
    end
    local wa, wb = ns.worth(a.p), ns.worth(b.p)
    if wa ~= wb then return wa > wb end
    return a.itemId < b.itemId
  end)
  return out
end

function ns.printList()
  local data = WAHP_DATA
  if not data or not data.items then
    ns.print("Noch keine Prognose-Daten. Läuft der Companion?")
    return
  end
  local rows = {}
  for _, tab in ipairs({ "sell", "buy" }) do
    for _, r in ipairs(ns.collect(tab)) do rows[#rows + 1] = r end
  end
  if #rows == 0 then
    ns.print("Gerade keine Kauf- oder Verkaufssignale.")
    return
  end
  ns.print(("%d Signale für %s:"):format(#rows, data.realm or "?"))
  for i = 1, math.min(10, #rows) do
    local r = rows[i]
    local link = select(2, ns.getItemInfo(r.itemId))
    local name = link or r.p.name or ("Item " .. r.itemId)
    local deadline = r.p.action == "buy" and r.p.buyUntil or r.p.sellTo
    local falling = (r.p.impact or 0) < 0
    local change = falling and ("fällt " .. ns.pct(r.p.impact)) or ns.pct(r.p.netUpside)
    ns.print(("  %s %s  %s%s"):format(colored(r.p.action), name, change, deadline and (", bis " .. ns.shortDate(deadline)) or ""))
  end
end

function ns.printStatus()
  local age = ns.dataAgeHours()
  if age then
    ns.print(("Prognosen für %s, %.1f h alt."):format(WAHP_DATA.realm or "?", age))
  else
    ns.print("Keine Prognose-Daten geladen.")
  end
  local scans = WAHP_DB and WAHP_DB.scans or {}
  local last = scans[#scans]
  if last then
    ns.print(("%d Scan(s) gespeichert, letzter: %s, %d Items."):format(#scans, date("%d.%m. %H:%M", last.scannedAt), last.itemCount or 0))
  else
    ns.print("Noch kein AH-Scan gespeichert. Am Auktionator: /wahp scan")
  end
end

local function help()
  ns.print("Befehle:")
  ns.print("  /wahp         Fenster mit Verkaufen, Kaufen, Taschen und Scan-Knopf")
  ns.print("  /wahp scan    AH komplett scannen (Auktionshaus muss offen sein)")
  ns.print("  /wahp list    Aktuelle Kauf-/Verkaufssignale im Chat")
  ns.print("  /wahp status  Alter der Daten und letzter Scan")
  ns.print("  /wahp auto    Fenster am Auktionshaus automatisch öffnen an/aus")
end

SLASH_WAHP1 = "/wahp"
SlashCmdList.WAHP = function(msg)
  local cmd = string.lower(string.match(msg or "", "^%s*(.-)%s*$"))
  if cmd == "" and ns.toggleWindow then
    ns.toggleWindow()
  elseif cmd == "scan" then
    ns.startScan()
  elseif cmd == "list" then
    ns.printList()
  elseif cmd == "status" then
    ns.printStatus()
  elseif cmd == "auto" then
    WAHP_DB.settings.autoOpen = WAHP_DB.settings.autoOpen == false
    ns.print("Fenster am Auktionshaus automatisch öffnen: " .. (WAHP_DB.settings.autoOpen and "an" or "aus"))
  else
    help()
  end
end

local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:SetScript("OnEvent", function(self, _, name)
  if name ~= ADDON then return end
  WAHP_DB = WAHP_DB or {}
  WAHP_DB.version = 1
  WAHP_DB.scans = WAHP_DB.scans or {}
  WAHP_DB.itemInfo = WAHP_DB.itemInfo or {}
  WAHP_DB.settings = WAHP_DB.settings or {}
  self:UnregisterEvent("ADDON_LOADED")
end)
