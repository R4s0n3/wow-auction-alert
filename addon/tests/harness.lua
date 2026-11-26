-- Minimaler Nachbau der WoW-API (Lua 5.1), gerade genug für dieses Addon.
local H = { chat = {}, timers = {}, frames = {}, auctions = {}, shift = false, api = "legacy" }

DEFAULT_CHAT_FRAME = {
  AddMessage = function(_, msg) H.chat[#H.chat + 1] = msg end,
}

-- Frames, Texturen, FontStrings: alles dasselbe Objekt. Bekannte Methoden merken sich
-- Zustand (Text, Sichtbarkeit, Scripts), unbekannte tun nichts. Reicht für UI-Code.
local Methods = {}
function Methods:RegisterEvent(e) self.events[e] = true end
function Methods:UnregisterEvent(e) self.events[e] = nil end
function Methods:SetScript(name, fn)
  self.scripts[name] = fn
  if name == "OnEvent" then self.onEvent = fn end
end
function Methods:GetScript(name) return self.scripts[name] end
function Methods:Show()
  local was = self.shown
  self.shown = true
  if not was and self.scripts.OnShow then self.scripts.OnShow(self) end
end
function Methods:Hide() self.shown = false end
function Methods:IsShown() return self.shown end
function Methods:SetText(t) self.text = t end
function Methods:GetText() return self.text or "" end
function Methods:Enable() self.enabled = true end
function Methods:Disable() self.enabled = false end
function Methods:IsEnabled() return self.enabled ~= false end
function Methods:SetTexture(t) self.texture = t end
function Methods:Click(button)
  if self.scripts.OnClick then self.scripts.OnClick(self, button or "LeftButton") end
end
local newObject
function Methods:CreateFontString() return newObject("FontString") end
function Methods:CreateTexture() return newObject("Texture") end

local function noop() end
newObject = function(kind)
  local o = { kind = kind, events = {}, scripts = {}, shown = true }
  -- Unbekannte Methoden (WoW-Stil: SetSize, SetPoint …) tun nichts, unbekannte Felder sind nil
  return setmetatable(o, {
    __index = function(_, k)
      if Methods[k] then return Methods[k] end
      if type(k) == "string" and k:match("^%u") then return noop end
      return nil
    end,
  })
end

function CreateFrame(kind, name, parent, template)
  local f = newObject(kind or "Frame")
  f.name, f.parent, f.template = name, parent, template
  if name then _G[name] = f end
  H.frames[#H.frames + 1] = f
  return f
end
UIParent = newObject("Frame")
UISpecialFrames = {}
tinsert = table.insert

function H.fire(event, ...)
  for _, f in ipairs(H.frames) do
    if f.events[event] and f.onEvent then f.onEvent(f, event, ...) end
  end
end

-- Timer mit Verzögerung. runTimers(max) führt nur Timer bis zu dieser Verzögerung aus,
-- ohne Argument alle (auch die, die währenddessen dazukommen).
C_Timer = { After = function(delay, fn) H.timers[#H.timers + 1] = { delay = delay or 0, fn = fn } end }
function H.runTimers(maxDelay)
  local ran = true
  while ran do
    ran = false
    for i, t in ipairs(H.timers) do
      if not maxDelay or t.delay <= maxDelay then
        table.remove(H.timers, i)
        t.fn()
        ran = true
        break
      end
    end
  end
end

FauxScrollFrame_Update = function(frame, n) frame.total = n end
FauxScrollFrame_GetOffset = function(frame) return frame.offset or 0 end
FauxScrollFrame_OnVerticalScroll = function(frame, value, height, update)
  frame.offset = math.floor(value / height + 0.5)
  update(frame)
end
GetItemIcon = function(itemId) return "icon-" .. itemId end
GetItemCount = function(itemId) return H.bags and H.bags[itemId] or 0 end
C_UI = { Reload = function() H.reloads = (H.reloads or 0) + 1 end }
ITEM_QUALITY_COLORS = { [0] = { hex = "|cff9d9d9d" }, [1] = { hex = "|cffffffff" }, [2] = { hex = "|cff1eff00" }, [3] = { hex = "|cff0070dd" } }

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

-- Wie im Client: itemID, Typ, Untertyp, Slot, Icon, classID, subclassID
GetItemInfoInstant = function(itemId)
  if itemId == 13466 or itemId == 13468 then return itemId, "Handwerkswaren", "Kräuter", "", 0, 7, 9 end
  return itemId, "Verschiedenes", "Verschiedenes", "", 0, 15, 0
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
  function t:SetOwner(owner) self.owner = owner end
  function t:SetItemByID(itemId) self.item = itemId end
  function t:Show() self.shown = true end
  function t:Hide() self.shown = false end
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
