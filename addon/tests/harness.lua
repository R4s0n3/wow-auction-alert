-- Minimaler Nachbau der WoW-API (Lua 5.1), gerade genug für dieses Addon.
local H = { chat = {}, timers = {}, frames = {}, auctions = {}, shift = false, api = "legacy" }

DEFAULT_CHAT_FRAME = {
  AddMessage = function(_, msg) H.chat[#H.chat + 1] = msg end,
}

function CreateFrame()
  local f = { events = {} }
  function f:RegisterEvent(e) self.events[e] = true end
  function f:UnregisterEvent(e) self.events[e] = nil end
  function f:SetScript(_, fn) self.onEvent = fn end
  H.frames[#H.frames + 1] = f
  return f
end

function H.fire(event, ...)
  for _, f in ipairs(H.frames) do
    if f.events[event] and f.onEvent then f.onEvent(f, event, ...) end
  end
end

C_Timer = { After = function(_, fn) H.timers[#H.timers + 1] = fn end }
function H.runTimers()
  while #H.timers > 0 do table.remove(H.timers, 1)() end
end

time = os.time
date = os.date
SlashCmdList = {}
GetRealmName = function() return "Everlook" end
UnitFactionGroup = function() return "Alliance", "Allianz" end
GetCurrentRegion = function() return 3 end
GetCoinTextureString = function(c)
  return ("%dg %ds %dc"):format(math.floor(c / 10000), math.floor(c % 10000 / 100), c % 100)
end
IsShiftKeyDown = function() return H.shift end

-- Auktionen: { itemId, count, buyout, name?, quality? }
local function row(a)
  return a[4] or "Name", nil, a[2], a[5] or 1, true, 60, "", 0, 0, a[3], 0, false, nil, "x", "x", 0, a[1], true
end

GetItemInfoInstant = function(itemId)
  if itemId == 13466 or itemId == 13468 then return itemId, "Handwerkswaren", "Kräuter" end
  return itemId, "Verschiedenes", "Verschiedenes"
end

function H.useApi(kind)
  H.api = kind
  if kind == "modern" then
    QueryAuctionItems, CanSendAuctionQuery, GetNumAuctionItems, GetAuctionItemInfo = nil, nil, nil, nil
    C_AuctionHouse = {
      ReplicateItems = function() H.queried = true end,
      GetNumReplicateItems = function() return #H.auctions end,
      GetReplicateItemInfo = function(i) return row(H.auctions[i + 1]) end, -- Index ab 0
    }
  else
    C_AuctionHouse = nil
    CanSendAuctionQuery = function() return true, H.canQueryAll ~= false end
    QueryAuctionItems = function(...) H.queried = { ... } end
    GetNumAuctionItems = function() return #H.auctions, #H.auctions end
    GetAuctionItemInfo = function(_, i) return row(H.auctions[i]) end
  end
end

local function newTooltip()
  local t = { lines = {} }
  function t:HookScript(_, fn) self.hook = fn end
  function t:AddLine(text, r, g, b, wrap) self.lines[#self.lines + 1] = { text, r, g, b, wrap } end
  function t:GetItem() return "Name", self.link end
  return t
end
GameTooltip = newTooltip()
ItemRefTooltip = newTooltip()

function H.hoverItem(itemId)
  GameTooltip.lines = {}
  GameTooltip.link = "|cffffffff|Hitem:" .. itemId .. "::::::::60:::::|h[Item]|h|r"
  GameTooltip.hook(GameTooltip)
  return GameTooltip.lines
end

-- Lädt das Addon wie der Client: Dateien in TOC-Reihenfolge, mit (Name, Namespace) als Varargs.
function H.loadAddon(dir, opts)
  opts = opts or {}
  H.useApi(opts.api or "legacy")
  local ns = {}
  for line in io.lines(dir .. "/WowAhPrediction.toc") do
    local file = line:match("^%s*([^#%s][^%s]*)%s*$")
    if file then
      local path = dir .. "/" .. file
      if file == "Data.lua" and opts.data then path = opts.data end
      assert(loadfile(path))("WowAhPrediction", ns)
    end
  end
  WAHP_DB = opts.savedVariables
  H.fire("ADDON_LOADED", "WowAhPrediction")
  return ns
end

-- Schreibt eine Tabelle so, wie WoW SavedVariables schreibt (inkl. "-- [n]" Kommentaren).
local function serialize(v, out)
  local t = type(v)
  if t == "table" then
    out[#out + 1] = "{\n"
    local n = #v
    for i = 1, n do
      serialize(v[i], out)
      out[#out + 1] = ", -- [" .. i .. "]\n"
    end
    local keys = {}
    for k in pairs(v) do
      if not (type(k) == "number" and k >= 1 and k <= n and k % 1 == 0) then keys[#keys + 1] = k end
    end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    for _, k in ipairs(keys) do
      out[#out + 1] = type(k) == "number" and ("[" .. k .. "] = ") or ("[%q] = "):format(k)
      serialize(v[k], out)
      out[#out + 1] = ",\n"
    end
    out[#out + 1] = "}"
  elseif t == "string" then
    out[#out + 1] = ("%q"):format(v)
  elseif t == "number" then
    out[#out + 1] = (v % 1 == 0) and ("%d"):format(v) or ("%.14g"):format(v)
  else
    out[#out + 1] = tostring(v)
  end
end

function H.writeSavedVariables(path, name, value)
  local out = { "\n", name, " = " }
  serialize(value, out)
  out[#out + 1] = "\n"
  local f = assert(io.open(path, "w"))
  f:write(table.concat(out))
  f:close()
end

return H
