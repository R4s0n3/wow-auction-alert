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

function ns.printList()
  local data = WAHP_DATA
  if not data or not data.items then
    ns.print("Noch keine Prognose-Daten. Läuft der Companion?")
    return
  end
  local rows = {}
  for itemId, preds in pairs(data.items) do
    for _, p in ipairs(preds) do
      if p.action == "buy" or p.action == "sell" then rows[#rows + 1] = { itemId = itemId, p = p } end
    end
  end
  table.sort(rows, function(a, b)
    if a.p.action ~= b.p.action then return a.p.action == "sell" end
    return (a.p.netUpside or 0) > (b.p.netUpside or 0)
  end)
  if #rows == 0 then
    ns.print("Gerade keine Kauf- oder Verkaufssignale.")
    return
  end
  ns.print(("%d Signale für %s:"):format(#rows, data.realm or "?"))
  for i = 1, math.min(10, #rows) do
    local r = rows[i]
    local link = GetItemInfo and select(2, GetItemInfo(r.itemId))
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
  ns.print("  /wahp scan    AH komplett scannen (Auktionshaus muss offen sein)")
  ns.print("  /wahp list    Aktuelle Kauf-/Verkaufssignale")
  ns.print("  /wahp status  Alter der Daten und letzter Scan")
end

SLASH_WAHP1 = "/wahp"
SlashCmdList.WAHP = function(msg)
  local cmd = string.lower(string.match(msg or "", "^%s*(.-)%s*$"))
  if cmd == "scan" then
    ns.startScan()
  elseif cmd == "list" then
    ns.printList()
  elseif cmd == "status" then
    ns.printStatus()
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
  self:UnregisterEvent("ADDON_LOADED")
end)
