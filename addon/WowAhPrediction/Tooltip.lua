local _, ns = ...

local GRAY = { 0.6, 0.6, 0.6 }
local LIGHT = { 0.85, 0.85, 0.85 }

local function sure(p)
  return ("%d %% sicher"):format(math.floor((p.confidence or 0) * 100 + 0.5))
end

-- impact < 0: Die Prognose erwartet einen Preisverfall (nur von der KI)
local function detail(p)
  local falling = (p.impact or 0) < 0
  if p.action == "buy" then
    local parts = {}
    if p.buyUntil then parts[#parts + 1] = "bis " .. ns.shortDate(p.buyUntil) end
    parts[#parts + 1] = "Peak " .. ns.pct(p.impact)
    parts[#parts + 1] = sure(p)
    return table.concat(parts, " · ")
  elseif p.action == "hold" then
    return p.sellFrom and ("halten, verkaufen ab " .. ns.shortDate(p.sellFrom)) or "halten"
  elseif p.action == "sell" then
    if falling then
      return ("vorher loswerden · Tief %s · %s"):format(ns.pct(p.impact), sure(p))
    end
    return p.sellTo and ("jetzt verkaufen, bis " .. ns.shortDate(p.sellTo)) or "jetzt verkaufen"
  elseif p.action == "avoid" then
    if falling then return "Preis fällt eher (" .. ns.pct(p.impact) .. ")" end
    return "Peak vorbei, Preis fällt"
  end
  return "kein guter Einstieg gerade"
end

-- Reine Funktion: baut die Tooltip-Zeilen, damit sie ohne Client testbar ist.
-- Jede Zeile: { text, r, g, b, wrap }
function ns.tooltipLines(preds, opts)
  local lines = {}
  local hasWhy = false
  for _, p in ipairs(preds) do
    lines[#lines + 1] = { ("AH-Prognose: %s  %s"):format(ns.colored(p.action), detail(p)), 1, 1, 1 }
    local falling = (p.impact or 0) < 0
    if p.current and p.peak and (p.action == "buy" or p.action == "hold" or (falling and p.action == "sell")) then
      lines[#lines + 1] = {
        ("Jetzt %s, %s ~%s"):format(ns.coinString(p.current), falling and "Tief" or "Peak", ns.coinString(p.peak)),
        LIGHT[1], LIGHT[2], LIGHT[3],
      }
    end
    local event = p.event or "?"
    if p.src == "ai" then event = "KI: " .. event end
    lines[#lines + 1] = { event, GRAY[1], GRAY[2], GRAY[3], true }
    if p.why then
      hasWhy = true
      if opts.shift then lines[#lines + 1] = { "Warum: " .. p.why, GRAY[1], GRAY[2], GRAY[3], true } end
    end
  end
  if hasWhy and not opts.shift then lines[#lines + 1] = { "(Shift: Begründung)", GRAY[1], GRAY[2], GRAY[3] } end
  if opts.ageHours and opts.ageHours > ns.STALE_HOURS then
    lines[#lines + 1] = { ("Prognose ist %d h alt. Läuft der Companion?"):format(math.floor(opts.ageHours)), 1, 0.4, 0.4 }
  end
  return lines
end

local function addTo(tooltip, itemId)
  if not itemId then return end
  local preds = ns.predictionsFor(itemId)
  if not preds or #preds == 0 then return end
  tooltip:AddLine(" ")
  for _, l in ipairs(ns.tooltipLines(preds, { shift = IsShiftKeyDown(), ageHours = ns.dataAgeHours() })) do
    tooltip:AddLine(l[1], l[2], l[3], l[4], l[5])
  end
end

local function idFromLink(link)
  return link and tonumber(string.match(link, "item:(%d+)"))
end

if TooltipDataProcessor and TooltipDataProcessor.AddTooltipPostCall and Enum and Enum.TooltipDataType then
  TooltipDataProcessor.AddTooltipPostCall(Enum.TooltipDataType.Item, function(tooltip, data)
    if tooltip == GameTooltip or tooltip == ItemRefTooltip then addTo(tooltip, data and data.id) end
  end)
else
  for _, tooltip in ipairs({ GameTooltip, ItemRefTooltip }) do
    tooltip:HookScript("OnTooltipSetItem", function(self)
      local _, link = self:GetItem()
      addTo(self, idFromLink(link))
    end)
  end
end
