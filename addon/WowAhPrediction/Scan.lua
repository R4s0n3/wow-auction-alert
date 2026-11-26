local _, ns = ...

-- Komplett-Scan des Auktionshauses. Welche API der Forever-Client hat, ist
-- nicht dokumentiert, deshalb werden beide unterstützt:
--   modern: C_AuctionHouse.ReplicateItems()  + REPLICATE_ITEM_LIST_UPDATE (Index ab 0)
--   alt:    QueryAuctionItems(..., getAll)  + AUCTION_ITEM_LIST_UPDATE   (Index ab 1)
-- Beide liefern pro Auktion dasselbe Tupel: name = 1., count = 3., quality = 4.,
-- buyout = 10., itemId = 17. Wert.
-- Blizzard erlaubt einen Komplett-Scan nur alle 15 Minuten.

local CHUNK = 500 -- Auktionen pro Frame, damit der Client nicht einfriert
local MARKET_SHARE = 0.15 -- Marktpreis = Ø der günstigsten 15 % der Menge
ns.SCAN_COOLDOWN = 15 * 60
local REPLY_TIMEOUT = 60 -- so lange warten wir auf die Antwort des Servers

local frame = CreateFrame("Frame")
local scanning = false
local ahOpen = false
local fromWindow = false

-- Andere Teile (das Fenster) hören hier mit: "ah", "scan-start", "scan-progress", "scan-done", "scan-abort"
ns.listeners = ns.listeners or {}
function ns.on(fn) ns.listeners[#ns.listeners + 1] = fn end
local function notify(event, ...)
  for _, fn in ipairs(ns.listeners) do fn(event, ...) end
end

function ns.isAhOpen() return ahOpen end
function ns.isScanning() return scanning end
function ns.scanStartedFromWindow() return fromWindow end

-- Sekunden bis zum nächsten erlaubten Komplett-Scan, 0 = jetzt möglich
function ns.cooldownLeft(now)
  local scans = WAHP_DB and WAHP_DB.scans
  local last = scans and scans[#scans]
  if not last or not last.scannedAt then return 0 end
  return math.max(0, last.scannedAt + ns.SCAN_COOLDOWN - (now or time()))
end

function ns.addAuction(agg, itemId, count, buyout)
  if not itemId or not count or count <= 0 or not buyout or buyout <= 0 then return end
  local list = agg[itemId]
  if not list then
    list = {}
    agg[itemId] = list
  end
  list[#list + 1] = { buyout / count, count }
end

-- Fasst die Rohdaten pro Item zusammen: Mindestpreis, Marktpreis, Menge.
function ns.summarize(agg)
  local out, n = {}, 0
  for itemId, list in pairs(agg) do
    table.sort(list, function(a, b) return a[1] < b[1] end)
    local total = 0
    for _, l in ipairs(list) do total = total + l[2] end
    local want = math.max(1, total * MARKET_SHARE)
    local got, sum = 0, 0
    for _, l in ipairs(list) do
      local take = math.min(l[2], want - got)
      sum = sum + take * l[1]
      got = got + take
      if got >= want then break end
    end
    out[itemId] = {
      min = math.max(1, math.floor(list[1][1])),
      mkt = math.max(1, math.floor(sum / got + 0.5)),
      q = total,
    }
    n = n + 1
  end
  return out, n
end

-- Name, Qualität und Kategorie pro Item, damit der Server (und die KI) weiß,
-- was hinter einer ID steckt. Liegt global in WAHP_DB.itemInfo, nicht pro Scan.
function ns.rememberItemInfo(names)
  local store = WAHP_DB.itemInfo
  -- Neuere Clients (auch Forever) haben die Funktion nur noch unter C_Item
  local instant = (C_Item and C_Item.GetItemInfoInstant) or GetItemInfoInstant
  for itemId, info in pairs(names) do
    local entry = store[itemId] or {}
    entry.n = info.n
    entry.ql = info.ql
    if entry.cls == nil and instant then
      -- itemID, Typ, Untertyp, Slot, Icon, classID, subclassID
      local _, itemType, itemSubType, _, _, classId, subclassId = instant(itemId)
      if type(classId) == "number" then
        entry.cls = classId
        entry.sub = subclassId
      end
      if itemType and itemType ~= "" then
        entry.c = (itemSubType and itemSubType ~= "" and itemSubType ~= itemType) and (itemType .. "/" .. itemSubType) or itemType
      end
    end
    store[itemId] = entry
  end
end

local function finish(agg, names, auctions)
  local items, itemCount = ns.summarize(agg)
  ns.rememberItemInfo(names)
  local scans = WAHP_DB.scans
  scans[#scans + 1] = {
    realm = GetRealmName(),
    faction = (UnitFactionGroup("player")),
    region = GetCurrentRegion and GetCurrentRegion() or 0,
    scannedAt = time(),
    auctions = auctions,
    itemCount = itemCount,
    items = items,
  }
  while #scans > ns.MAX_SCANS do table.remove(scans, 1) end
  scanning = false
  if fromWindow then
    ns.print(("Scan fertig: %d Auktionen, %d Items. Gleich wird neu geladen, damit der Companion ihn hochlädt."):format(auctions, itemCount))
  else
    ns.print(("Scan fertig: %d Auktionen, %d Items. Nach /reload lädt der Companion ihn hoch."):format(auctions, itemCount))
  end
  notify("scan-done", auctions, itemCount)
end

-- Arbeitet die Auktionen in Häppchen über mehrere Frames ab.
local function process(getRow, first, last)
  local agg, names, i = {}, {}, first
  local function step()
    if not scanning then return end
    local stop = math.min(i + CHUNK - 1, last)
    for idx = i, stop do
      local name, _, count, quality, _, _, _, _, _, buyout, _, _, _, _, _, _, itemId = getRow(idx)
      ns.addAuction(agg, itemId, count, buyout)
      if itemId and agg[itemId] and not names[itemId] and name and name ~= "" then
        names[itemId] = { n = name, ql = quality }
      end
    end
    i = stop + 1
    if i > last then
      finish(agg, names, last - first + 1)
    else
      notify("scan-progress", i - first, last - first + 1)
      C_Timer.After(0, step)
    end
  end
  step()
end

local function useModernApi()
  return C_AuctionHouse ~= nil and C_AuctionHouse.ReplicateItems ~= nil
end

local function abort(msg)
  scanning = false
  frame:UnregisterEvent("AUCTION_ITEM_LIST_UPDATE")
  frame:UnregisterEvent("REPLICATE_ITEM_LIST_UPDATE")
  ns.print(msg)
  notify("scan-abort", msg)
end

-- opts.fromWindow: vom Knopf im Fenster gestartet, danach lädt das Fenster neu
function ns.startScan(opts)
  if scanning then
    ns.print("Scan läuft schon.")
    return false
  end
  if not ahOpen then
    ns.print("Öffne zuerst das Auktionshaus.")
    return false
  end
  local wait = ns.cooldownLeft()
  if useModernApi() then
    if wait > 0 then
      ns.print(("Komplett-Scan geht nur alle 15 Minuten. Noch %d Min."):format(math.ceil(wait / 60)))
      return false
    end
    scanning = true
    frame:RegisterEvent("REPLICATE_ITEM_LIST_UPDATE")
    C_AuctionHouse.ReplicateItems()
    -- Antwortet der Server nicht (z. B. Sperre, die wir nicht kennen), nicht ewig "scannen"
    local started = time()
    C_Timer.After(REPLY_TIMEOUT, function()
      if scanning and frame.waiting == started then abort("Das Auktionshaus hat nicht geantwortet, Scan abgebrochen.") end
    end)
    frame.waiting = started
  elseif QueryAuctionItems then
    local _, canQueryAll = CanSendAuctionQuery()
    if not canQueryAll then
      ns.print("Komplett-Scan geht nur alle 15 Minuten. Versuch es gleich nochmal.")
      return false
    end
    scanning = true
    frame:RegisterEvent("AUCTION_ITEM_LIST_UPDATE")
    QueryAuctionItems("", nil, nil, 0, nil, nil, true, false, nil)
  else
    ns.print("Dieser Client hat keine bekannte AH-Scan-API.")
    return false
  end
  fromWindow = opts and opts.fromWindow or false
  ns.print("Scanne das Auktionshaus, das kann einen Moment dauern …")
  notify("scan-start")
  return true
end

frame:RegisterEvent("AUCTION_HOUSE_SHOW")
frame:RegisterEvent("AUCTION_HOUSE_CLOSED")
frame:SetScript("OnEvent", function(self, event)
  if event == "AUCTION_HOUSE_SHOW" then
    ahOpen = true
    notify("ah", true)
  elseif event == "AUCTION_HOUSE_CLOSED" then
    ahOpen = false
    if scanning then abort("Auktionshaus geschlossen, Scan abgebrochen.") end
    notify("ah", false)
  elseif event == "REPLICATE_ITEM_LIST_UPDATE" then
    self:UnregisterEvent(event)
    self.waiting = nil
    process(C_AuctionHouse.GetReplicateItemInfo, 0, C_AuctionHouse.GetNumReplicateItems() - 1)
  elseif event == "AUCTION_ITEM_LIST_UPDATE" then
    self:UnregisterEvent(event)
    local count = GetNumAuctionItems("list")
    process(function(i) return GetAuctionItemInfo("list", i) end, 1, count)
  end
end)
