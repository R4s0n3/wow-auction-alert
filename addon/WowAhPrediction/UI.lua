local _, ns = ...

-- Fenster mit drei Listen (Verkaufen, Kaufen, was du in den Taschen hast), Suche,
-- Details mit Begründung und Wowhead-Link, und dem Scan-Knopf. Nach einem Scan
-- über den Knopf lädt das Fenster nach kurzem Countdown neu, damit WoW die Daten
-- speichert und der Companion sie hochladen kann.
--
-- Bilder statt Text: Item-Icons und Münzen kommen aus dem Client, die Sicherheit
-- ist ein Balken. Die WoW-Schrift kann keine Emojis, deshalb keine im Fenster.

local W, H = 480, 636
local LIST_TOP = -96 -- unter Tabs und Kategorie-Leiste
local ROWS, ROW_H = 8, 46
local RELOAD_DELAY = 3
local QUESTION_MARK = 134400 -- INV_Misc_QuestionMark
local TABS = {
  { key = "sell", label = "Verkaufen", color = "ffff5544" },
  { key = "buy", label = "Kaufen", color = "ff33dd55" },
  { key = "bags", label = "Taschen", color = "ffffd100" },
}

local state = { tab = "sell", cat = "focus", query = "", selected = nil, list = {}, countdown = nil, reloadPending = false, progress = nil }
local f -- Hauptfenster, wird beim ersten Öffnen gebaut
local ui = { rows = {}, tabs = TABS }
ns.ui = ui
ns.uiState = state

-- Hilfen ----------------------------------------------------------------------

function ns.wowheadUrl(itemId)
  return "https://www.wowhead.com/forever/de/item=" .. itemId
end

local function itemIcon(itemId)
  local icon = C_Item and C_Item.GetItemIconByID and C_Item.GetItemIconByID(itemId)
  if not icon and GetItemIcon then icon = GetItemIcon(itemId) end
  return icon or QUESTION_MARK
end

local function qualityOf(itemId)
  local q = C_Item and C_Item.GetItemQualityByID and C_Item.GetItemQualityByID(itemId)
  if not q then
    local info = WAHP_DB and WAHP_DB.itemInfo and WAHP_DB.itemInfo[itemId]
    q = info and info.ql
  end
  return q or 1
end

local function qualityHex(q)
  local c = ITEM_QUALITY_COLORS and ITEM_QUALITY_COLORS[q]
  if c and c.hex then return c.hex end
  local qualityColor = (C_Item and C_Item.GetItemQualityColor) or GetItemQualityColor
  if qualityColor then
    local _, _, _, hex = qualityColor(q)
    if hex then return "|c" .. hex end
  end
  return "|cffffffff"
end

-- 75g 93s mit Münz-Icons, ab 1g ohne Kupfer, ab 100g ohne Silber
function ns.coins(copper)
  copper = math.floor((copper or 0) + 0.5)
  if copper >= 1000000 then
    copper = math.floor(copper / 10000) * 10000
  elseif copper >= 10000 then
    copper = math.floor(copper / 100) * 100
  end
  return ns.coinString(copper)
end

-- Großes Badge rechts: +42 % grün, -30 % rot, Peak gelb, sonst die Aktion
function ns.changeText(p)
  if p.action == "buy" then return ("|cff33dd55+%d %%|r"):format(math.floor((p.netUpside or 0) * 100 + 0.5)) end
  if (p.impact or 0) < 0 and (p.action == "sell" or p.action == "avoid") then
    return ("|cffff5544-%d %%|r"):format(math.floor(-(p.impact or 0) * 100 + 0.5))
  end
  if p.action == "sell" then return "|cffffcc33Peak|r" end
  return ns.colored(p.action)
end

-- Zweite Zeile: Preis jetzt » Ziel, Frist, Anzahl in den Taschen
function ns.rowDetail(p, count)
  local parts = {}
  if p.current then
    if p.peak and not (p.action == "sell" and (p.impact or 0) >= 0) then
      parts[#parts + 1] = ns.coins(p.current) .. "  |cff888888»|r  " .. ns.coins(p.peak)
    else
      parts[#parts + 1] = ns.coins(p.current)
    end
  end
  local deadline = (p.action == "buy" and p.buyUntil) or (p.action ~= "buy" and p.sellTo) or nil
  if deadline then
    parts[#parts + 1] = "|cffaaaaaabis " .. ns.shortDate(deadline) .. "|r"
  elseif p.action == "sell" then
    parts[#parts + 1] = "|cffaaaaaajetzt|r"
  end
  if count then parts[#parts + 1] = ("|cffffd100%dx|r"):format(count) end
  return table.concat(parts, "    ")
end

-- "[Verfügung]" / "[Kisten]": die Handwerks-Fraktion verlangt das Item (Feld uses in Data.lua)
function ns.usesTag(p)
  local uses = p.uses or ""
  local writ = string.find(uses, "Handwerksverfügung", 1, true) ~= nil
  local crate = string.find(uses, "Abgefangene Kiste", 1, true) ~= nil
  if writ and crate then return "  |cffe0a25a[Verfügung, Kisten]|r" end
  if writ then return "  |cffe0a25a[Verfügung]|r" end
  if crate then return "  |cffe0a25a[Kisten]|r" end
  return ""
end

function ns.reload()
  if C_UI and C_UI.Reload then C_UI.Reload() else ReloadUI() end
end

-- Bausteine -------------------------------------------------------------------

local function confidenceBar(parent)
  local bar = {}
  for i = 1, 5 do
    local t = parent:CreateTexture(nil, "ARTWORK")
    t:SetSize(7, 7)
    t:SetColorTexture(1, 1, 1, 1)
    bar[i] = t
  end
  function bar:SetValue(conf)
    local n = math.max(1, math.min(5, math.floor((conf or 0) * 5 + 0.5)))
    for i = 1, 5 do
      if i <= n then self[i]:SetVertexColor(0.88, 0.64, 0.35, 1) else self[i]:SetVertexColor(0.3, 0.3, 0.33, 1) end
    end
  end
  function bar:SetPoint(...)
    self[1]:SetPoint(...)
    for i = 2, 5 do self[i]:SetPoint("LEFT", self[i - 1], "RIGHT", 2, 0) end
  end
  return bar
end

local function selected()
  local id = state.selected
  local preds = id and ns.predictionsFor(id)
  return preds and preds[1] and { itemId = id, p = preds[1] } or nil
end

local function fillRow(row, r)
  local p = r.p
  row.itemId = r.itemId
  row.icon:SetTexture(itemIcon(r.itemId))
  row.name:SetText(qualityHex(qualityOf(r.itemId)) .. (p.name or ("Item " .. r.itemId)) .. "|r" .. ns.usesTag(p) .. (p.src == "ai" and "  |cff777777KI|r" or ""))
  row.badge:SetText(ns.changeText(p))
  row.sub:SetText(ns.rowDetail(p, r.count))
  row.conf:SetValue(p.confidence)
  if row.selected then
    if state.selected == r.itemId then row.selected:Show() else row.selected:Hide() end
  end
end

local function emptyText()
  if not WAHP_DATA or not WAHP_DATA.items then return "Noch keine Prognosen geladen. Läuft der Companion?" end
  if state.query ~= "" then return "Nichts gefunden für \"" .. state.query .. "\"." end
  if state.tab == "bags" then return "Nichts mit Prognose in deinen Taschen oder auf der Bank." end
  if state.cat ~= "all" then return "Nichts in dieser Kategorie. Probier \"Alle\"." end
  return "Gerade keine Signale."
end

-- Aktualisieren -----------------------------------------------------------------

function ui.updateFooter()
  if not f then return end
  local parts = {}
  local data = WAHP_DATA
  if data and data.generatedAt then
    local age = ns.dataAgeHours() or 0
    local text = "Prognosen " .. date("%d.%m. %H:%M", data.generatedAt)
    parts[#parts + 1] = age > ns.STALE_HOURS and ("|cffff6666" .. text .. "|r") or text
  else
    parts[#parts + 1] = "|cffff6666Keine Prognosen geladen|r"
  end
  local scans = WAHP_DB and WAHP_DB.scans or {}
  local last = scans[#scans]
  if last then parts[#parts + 1] = "Scan " .. date("%d.%m. %H:%M", last.scannedAt) end
  ui.status:SetText(table.concat(parts, "  ·  "))

  local b = ui.scanButton
  if state.countdown then
    b:Enable()
    b:SetText(("Abbrechen (Reload in %d)"):format(state.countdown))
  elseif state.reloadPending then
    b:Enable()
    b:SetText("Jetzt neu laden")
  elseif ns.isScanning() then
    b:Disable()
    b:SetText(state.progress and ("Scanne … %d %%"):format(state.progress) or "Scanne …")
  elseif not ns.isAhOpen() then
    b:Disable()
    b:SetText("Scan am Auktionshaus")
  else
    local wait = ns.cooldownLeft()
    if wait > 0 then
      b:Disable()
      b:SetText(("Scan in %d Min."):format(math.ceil(wait / 60)))
    else
      b:Enable()
      b:SetText("AH scannen")
    end
  end
end

function ui.updateDetails()
  if not f then return end
  local d = ui.details
  local r = selected()
  if not r then
    d.hint:Show()
    for _, k in ipairs({ "icon", "name", "change", "prices", "why", "link", "linkLabel" }) do d[k]:Hide() end
    d.conf:SetValue(0)
    for i = 1, 5 do d.conf[i]:Hide() end
    return
  end
  local p = r.p
  d.hint:Hide()
  for _, k in ipairs({ "icon", "name", "change", "prices", "why", "link", "linkLabel" }) do d[k]:Show() end
  for i = 1, 5 do d.conf[i]:Show() end
  d.icon:SetTexture(itemIcon(r.itemId))
  d.name:SetText(qualityHex(qualityOf(r.itemId)) .. (p.name or ("Item " .. r.itemId)) .. "|r")
  d.change:SetText(ns.colored(p.action) .. "   " .. ns.changeText(p) .. ("   |cffaaaaaa%d %% sicher|r"):format(math.floor((p.confidence or 0) * 100 + 0.5)))
  d.prices:SetText(ns.rowDetail(p, r.count or (ns.itemCount(r.itemId) > 0 and ns.itemCount(r.itemId) or nil)))
  local event = (p.src == "ai" and "KI: " or "") .. (p.event or "")
  d.why:SetText("|cffffd100" .. event .. "|r" .. (p.why and ("\n" .. p.why) or "") .. (p.uses and ("\n|cffe0a25aVerlangt von: " .. p.uses .. "|r") or ""))
  d.conf:SetValue(p.confidence)
  d.link:SetText(ns.wowheadUrl(r.itemId))
  d.link:SetCursorPosition(0)
end

function ui.refresh()
  if not f or not f:IsShown() then return end
  local cats = ns.categoryFilter(state.cat)
  state.list = ns.collect(state.tab, state.query, cats)
  for _, t in ipairs(TABS) do
    t.button:SetText(("|c%s%s|r  %d"):format(t.color, t.label, #ns.collect(t.key, state.query, cats)))
    if t.key == state.tab then t.button:LockHighlight() else t.button:UnlockHighlight() end
  end
  for key, b in pairs(ui.catButtons) do
    if key == state.cat then b:LockHighlight() else b:UnlockHighlight() end
  end
  FauxScrollFrame_Update(ui.scroll, #state.list, ROWS, ROW_H)
  local offset = FauxScrollFrame_GetOffset(ui.scroll)
  for i, row in ipairs(ui.rows) do
    local r = state.list[offset + i]
    if r then
      fillRow(row, r)
      row:Show()
    else
      row.itemId = nil
      row:Hide()
    end
  end
  ui.empty:SetText(#state.list == 0 and emptyText() or "")
  ui.updateDetails()
  ui.updateFooter()
end

function ui.setTab(key)
  state.tab = key
  if ui.scroll then FauxScrollFrame_OnVerticalScroll(ui.scroll, 0, ROW_H, ui.refresh) end
  ui.refresh()
end

function ui.setCategory(key)
  state.cat = key
  WAHP_DB.settings.category = key
  ui.setTab(state.tab)
end

function ui.select(itemId)
  state.selected = itemId
  ui.refresh()
end

-- Aufbau ------------------------------------------------------------------------

local function build()
  f = CreateFrame("Frame", "WAHPFrame", UIParent, BackdropTemplateMixin and "BackdropTemplate" or nil)
  ui.frame = f
  f:SetSize(W, H)
  f:SetFrameStrata("HIGH")
  f:SetClampedToScreen(true)
  f:SetMovable(true)
  f:EnableMouse(true)
  f:RegisterForDrag("LeftButton")
  f:SetScript("OnDragStart", function(self) self:StartMoving() end)
  f:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local point, _, relPoint, x, y = self:GetPoint()
    WAHP_DB.settings.point = { point, relPoint, x, y }
  end)
  if f.SetBackdrop then
    f:SetBackdrop({
      bgFile = "Interface\\Buttons\\WHITE8x8",
      edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
      edgeSize = 14,
      insets = { left = 3, right = 3, top = 3, bottom = 3 },
    })
    f:SetBackdropColor(0.05, 0.06, 0.08, 0.96)
    f:SetBackdropBorderColor(0.35, 0.35, 0.4, 1)
  end
  tinsert(UISpecialFrames, "WAHPFrame") -- ESC schließt
  f:Hide()

  local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  title:SetPoint("TOPLEFT", 14, -12)
  title:SetText("AH-Prognose")
  ui.realm = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  ui.realm:SetPoint("LEFT", title, "RIGHT", 8, -1)
  local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
  close:SetPoint("TOPRIGHT", -2, -2)

  -- Tabs
  local prev
  for _, t in ipairs(TABS) do
    local b = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
    b:SetSize(118, 24)
    if prev then b:SetPoint("LEFT", prev, "RIGHT", 4, 0) else b:SetPoint("TOPLEFT", 12, -38) end
    b:SetScript("OnClick", function() ui.setTab(t.key) end)
    t.button = b
    prev = b
  end

  -- Suche
  local search = CreateFrame("EditBox", nil, f, "InputBoxTemplate")
  search:SetSize(96, 20)
  search:SetPoint("LEFT", prev, "RIGHT", 12, 0)
  search:SetAutoFocus(false)
  local placeholder = search:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  placeholder:SetPoint("LEFT", 2, 0)
  placeholder:SetText("Suchen …")
  search:SetScript("OnTextChanged", function(self)
    state.query = self:GetText() or ""
    if state.query == "" then placeholder:Show() else placeholder:Hide() end
    ui.setTab(state.tab)
  end)
  search:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
  search:SetScript("OnEnterPressed", function(self) self:ClearFocus() end)
  ui.search = search

  -- Kategorie-Leiste: Fokus (Waren + Fraktion), einzelne Kategorien, Alle
  local prevCat
  ui.catButtons = {}
  for _, c in ipairs(ns.CATEGORY_FILTERS) do
    local b = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
    b:SetSize(72, 20)
    if prevCat then b:SetPoint("LEFT", prevCat, "RIGHT", 3, 0) else b:SetPoint("TOPLEFT", 12, -66) end
    b:SetText(c.label)
    b:SetScript("OnClick", function() ui.setCategory(c.key) end)
    ui.catButtons[c.key] = b
    prevCat = b
  end

  -- Liste
  local scroll = CreateFrame("ScrollFrame", "WAHPScroll", f, "FauxScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", 10, LIST_TOP)
  scroll:SetSize(W - 40, ROWS * ROW_H)
  scroll:SetScript("OnVerticalScroll", function(self, offset)
    FauxScrollFrame_OnVerticalScroll(self, offset, ROW_H, ui.refresh)
  end)
  ui.scroll = scroll

  for i = 1, ROWS do
    local row = CreateFrame("Button", nil, f)
    row:SetSize(W - 44, ROW_H - 4)
    row:SetPoint("TOPLEFT", scroll, "TOPLEFT", 0, -(i - 1) * ROW_H)
    row:RegisterForClicks("LeftButtonUp")
    local bg = row:CreateTexture(nil, "BACKGROUND")
    bg:SetAllPoints()
    bg:SetColorTexture(1, 1, 1, i % 2 == 0 and 0.03 or 0.06)
    row:SetHighlightTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight", "ADD")
    row.selected = row:CreateTexture(nil, "BORDER")
    row.selected:SetAllPoints()
    row.selected:SetColorTexture(0.88, 0.64, 0.35, 0.18)
    row.selected:Hide()
    row.icon = row:CreateTexture(nil, "ARTWORK")
    row.icon:SetSize(36, 36)
    row.icon:SetPoint("LEFT", 4, 0)
    row.name = row:CreateFontString(nil, "OVERLAY", "GameFontNormal")
    row.name:SetPoint("TOPLEFT", row.icon, "TOPRIGHT", 8, -2)
    row.name:SetPoint("RIGHT", row, "RIGHT", -86, 0)
    row.name:SetJustifyH("LEFT")
    row.name:SetWordWrap(false)
    row.sub = row:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
    row.sub:SetPoint("BOTTOMLEFT", row.icon, "BOTTOMRIGHT", 8, 2)
    row.sub:SetJustifyH("LEFT")
    row.badge = row:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
    row.badge:SetPoint("TOPRIGHT", -8, -5)
    row.conf = confidenceBar(row)
    row.conf:SetPoint("BOTTOMRIGHT", row, "BOTTOMRIGHT", -46, 7)
    row:SetScript("OnEnter", function(self)
      if not self.itemId then return end
      GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
      GameTooltip:SetItemByID(self.itemId) -- unser Tooltip-Hook hängt die Prognose an
      GameTooltip:Show()
    end)
    row:SetScript("OnLeave", function() GameTooltip:Hide() end)
    row:SetScript("OnClick", function(self)
      if not self.itemId then return end
      if IsShiftKeyDown() and ChatEdit_InsertLink then
        local _, link = ns.getItemInfo(self.itemId)
        if link then ChatEdit_InsertLink(link) return end
      end
      ui.select(self.itemId)
    end)
    row:EnableMouseWheel(true)
    row:SetScript("OnMouseWheel", function(_, delta)
      local bar = _G["WAHPScrollScrollBar"]
      if bar then bar:SetValue(bar:GetValue() - delta * ROW_H * 3) end
    end)
    ui.rows[i] = row
  end
  ui.empty = f:CreateFontString(nil, "OVERLAY", "GameFontDisable")
  ui.empty:SetPoint("TOP", scroll, "TOP", 0, -40)

  -- Details
  local d = {}
  ui.details = d
  local top = LIST_TOP - 8 - ROWS * ROW_H
  local line = f:CreateTexture(nil, "ARTWORK")
  line:SetColorTexture(1, 1, 1, 0.08)
  line:SetPoint("TOPLEFT", 12, top)
  line:SetSize(W - 24, 1)
  d.hint = f:CreateFontString(nil, "OVERLAY", "GameFontDisable")
  d.hint:SetPoint("TOPLEFT", 16, top - 14)
  d.hint:SetWidth(W - 32)
  d.hint:SetJustifyH("LEFT")
  d.hint:SetText("Klick auf ein Item für Begründung und Wowhead-Link.\nShift-Klick verlinkt es im Chat, Mausrad blättert.")
  d.icon = f:CreateTexture(nil, "ARTWORK")
  d.icon:SetSize(40, 40)
  d.icon:SetPoint("TOPLEFT", 14, top - 10)
  d.name = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  d.name:SetPoint("TOPLEFT", d.icon, "TOPRIGHT", 10, -1)
  d.name:SetPoint("RIGHT", f, "RIGHT", -14, 0)
  d.name:SetJustifyH("LEFT")
  d.change = f:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  d.change:SetPoint("BOTTOMLEFT", d.icon, "BOTTOMRIGHT", 10, 1)
  d.conf = confidenceBar(f)
  d.conf:SetPoint("TOPRIGHT", f, "TOPRIGHT", -54, top - 40)
  d.prices = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  d.prices:SetPoint("TOPLEFT", d.icon, "BOTTOMLEFT", 0, -8)
  d.why = f:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  d.why:SetPoint("TOPLEFT", d.prices, "BOTTOMLEFT", 0, -6)
  d.why:SetWidth(W - 28)
  d.why:SetJustifyH("LEFT")
  d.why:SetSpacing(2)
  if d.why.SetMaxLines then d.why:SetMaxLines(4) end
  d.linkLabel = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  d.linkLabel:SetPoint("BOTTOMLEFT", 16, 46)
  d.linkLabel:SetText("Wowhead")
  d.link = CreateFrame("EditBox", nil, f, "InputBoxTemplate")
  d.link:SetSize(W - 100, 18)
  d.link:SetPoint("LEFT", d.linkLabel, "RIGHT", 10, 0)
  d.link:SetAutoFocus(false)
  d.link:SetScript("OnEditFocusGained", function(self) self:HighlightText() end)
  d.link:SetScript("OnTextChanged", function(self, userInput)
    -- nur zum Kopieren (Strg+C), nicht zum Bearbeiten
    local r = selected()
    if userInput and r then self:SetText(ns.wowheadUrl(r.itemId)) self:HighlightText() end
  end)
  d.link:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)

  -- Fußzeile mit Status und Scan-Knopf
  ui.status = f:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  ui.status:SetPoint("BOTTOMLEFT", 16, 18)
  local scanButton = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
  scanButton:SetSize(190, 26)
  scanButton:SetPoint("BOTTOMRIGHT", -12, 12)
  scanButton:SetScript("OnClick", function()
    if state.countdown then
      state.countdown = nil -- abgebrochen, Reload später per Knopf
      state.reloadPending = true
    elseif state.reloadPending then
      ns.reload()
      return
    elseif ns.startScan({ fromWindow = true }) then
      state.progress = 0
    end
    ui.updateFooter()
  end)
  ui.scanButton = scanButton

  f:SetScript("OnShow", function() ui.refresh() end)
  f:RegisterEvent("BAG_UPDATE_DELAYED")
  f:SetScript("OnEvent", function()
    if state.tab == "bags" then ui.refresh() end
  end)
  local elapsed = 0
  f:SetScript("OnUpdate", function(_, dt)
    elapsed = elapsed + dt
    if elapsed >= 5 then
      elapsed = 0
      ui.updateFooter() -- Cooldown runterzählen
    end
  end)
end

local function place()
  f:ClearAllPoints()
  local saved = WAHP_DB.settings.point
  local ah = (AuctionHouseFrame and AuctionHouseFrame:IsShown() and AuctionHouseFrame) or (AuctionFrame and AuctionFrame:IsShown() and AuctionFrame)
  if saved then
    f:SetPoint(saved[1], UIParent, saved[2], saved[3], saved[4])
  elseif ah then
    f:SetPoint("TOPLEFT", ah, "TOPRIGHT", 12, 0)
  else
    f:SetPoint("CENTER")
  end
end

function ns.showWindow()
  if not f then build() end
  for _, c in ipairs(ns.CATEGORY_FILTERS) do
    if c.key == WAHP_DB.settings.category then state.cat = c.key end -- zuletzt gewählte Kategorie
  end
  place()
  ui.realm:SetText(WAHP_DATA and WAHP_DATA.realm or "")
  f:Show()
  ui.refresh()
end

function ns.toggleWindow()
  if f and f:IsShown() then f:Hide() else ns.showWindow() end
end

local function startCountdown()
  state.countdown = RELOAD_DELAY
  local function step()
    if not state.countdown then return end -- abgebrochen
    state.countdown = state.countdown - 1
    if state.countdown <= 0 then
      state.countdown = nil
      ns.reload()
      return
    end
    ui.updateFooter()
    C_Timer.After(1, step)
  end
  C_Timer.After(1, step)
end

ns.on(function(event, a, b)
  if event == "ah" then
    if a and WAHP_DB and WAHP_DB.settings and WAHP_DB.settings.autoOpen ~= false then ns.showWindow() end
    ui.updateFooter()
  elseif event == "scan-start" then
    state.progress = 0
    ui.updateFooter()
  elseif event == "scan-progress" then
    state.progress = math.floor(a / math.max(1, b) * 100)
    ui.updateFooter()
  elseif event == "scan-done" then
    state.progress = nil
    -- Nur nach einem Scan über den Knopf automatisch neu laden, nach /wahp scan nicht
    if ns.scanStartedFromWindow() then startCountdown() end
    ui.updateFooter()
  elseif event == "scan-abort" then
    state.progress = nil
    ui.updateFooter()
  end
end)
