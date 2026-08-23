import {
  GameRuleError,
  availableUnitCount,
  availableBoardingCapacity,
  availableUpgrades,
  boardTroops,
  buyWorldUpgrade,
  canBuyIn,
  canReach,
  cancelAction,
  checkVictory,
  chooseNavalDoctrine,
  countryResourceBonus,
  displayCountry,
  endTurn,
  maxPurchasableUnits,
  navalTransportMultiplier,
  newGame,
  publicCountryView,
  queueBuy,
  queueMove,
  queueUpgrade,
  unitCost,
  useSpyAction,
  useStrategicWeapon,
  validateSavedGame,
} from "./engine.js";
import { FACTION_META, OBJECTIVES, RESOURCE_IMAGES, RESOURCE_NAMES, SPY_ACTIONS, UNIT_TYPES, upgradeById } from "./config.js";
import { CAPITAL_MARKER_OVERRIDES, decodeHitColor, encodeHitColor, projectMapPoint } from "./projection.js";

const SAVE_KEY = "wargame-preservation-save-v1";
const PREFERENCES_KEY = "wargame-preservation-preferences-v1";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const asset = (name) => `./assets/${name}`;

let gameData;
let localization;
let gameState = null;
let selectedCountry = null;
let selectedFaction = null;
let toastTimer;
let sessionSaveBaseline = null;
let battleColorOverride = null;
let battleSkipCurrent = false;
let battleSkipAll = false;
let currentBattleAudio = null;
let preferences = readPreferences();

const canvas = $("#world-map");
const context = canvas.getContext("2d", { alpha: false });
const hitCanvas = document.createElement("canvas");
const hitContext = hitCanvas.getContext("2d", { willReadFrequently: true });
const mapView = { zoom: 1, panX: 0, panY: 0, dragging: false, moved: 0, lastX: 0, lastY: 0 };
const countryEdges = [];
const audioSources = {
  march: "./assets/audio/marchSound.wav",
  attack1: "./assets/audio/attack1Sound.wav",
  attack2: "./assets/audio/attack2Sound.wav",
  attack3: "./assets/audio/attack3Sound.wav",
  attack4: "./assets/audio/attack4Sound.wav",
  failed: "./assets/audio/attackFailed.wav",
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function localized(key, fallback = key) {
  return localization?.[key] || fallback;
}

function countryLabel(name) {
  return localized(name, displayCountry(name));
}

function countriesAlphabetically(countries = gameData.countries) {
  return [...countries].sort((first, second) => countryLabel(first.name).localeCompare(countryLabel(second.name), undefined, { sensitivity: "base" }));
}

function resourceBonusText(countryName, revealInfrastructure = true) {
  const bonus = countryResourceBonus(gameData, gameState, countryName);
  if (!revealInfrastructure && gameState.countries[countryName].upgrades.includes(15)) {
    bonus.costDiscount /= 2;
    bonus.cash /= 2;
    for (const unitType of Object.keys(bonus.units)) bonus.units[unitType] /= 2;
  }
  if (bonus.costDiscount) return `${Math.round(bonus.costDiscount * 100)}% off ships, planes & missiles`;
  if (bonus.cash) return `$${bonus.cash}/year`;
  const [unitType, quantity] = Object.entries(bonus.units)[0] || [];
  return unitType ? `${quantity} ${quantity === 1 ? UNIT_TYPES[unitType].singular : UNIT_TYPES[unitType].label.toLowerCase()}/year` : "No yearly bonus";
}

function readPreferences() {
  try {
    return { soundFx: true, combatAnimations: true, ...JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}") };
  } catch {
    return { soundFx: true, combatAnimations: true };
  }
}

function savePreferences() {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  document.documentElement.classList.toggle("combat-motion-off", !preferences.combatAnimations);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function stopBattleAudio() {
  if (!currentBattleAudio) return;
  currentBattleAudio.pause();
  currentBattleAudio.currentTime = 0;
  currentBattleAudio = null;
}

function playBattleSound(name, volume = 0.72) {
  stopBattleAudio();
  if (!preferences.soundFx || !audioSources[name]) return;
  const audio = new Audio(audioSources[name]);
  audio.volume = volume;
  currentBattleAudio = audio;
  audio.play().catch(() => {});
}

function showScreen(id) {
  $$(".screen").forEach((screen) => screen.classList.toggle("active", screen.id === id));
  if (id === "menu-screen") updateResumeButton();
  if (id === "game-screen") requestAnimationFrame(() => { resizeMap(); renderAll(); });
}

function notify(message, kind = "info") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 3000);
}

function withRules(action) {
  try {
    action();
    autosave();
    renderAll();
    checkEnding();
    return true;
  } catch (error) {
    if (error instanceof GameRuleError) {
      notify(error.message, "bad");
      return false;
    }
    else throw error;
  }
}

function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validateSavedGame(parsed, gameData) ? parsed : null;
  } catch {
    return null;
  }
}

function autosave() {
  if (gameState) localStorage.setItem(SAVE_KEY, JSON.stringify(gameState));
}

function updateResumeButton() {
  $("#resume-button").disabled = !readSave();
}

function buildSetup() {
  const grid = $("#faction-grid");
  grid.innerHTML = "";
  for (const faction of gameData.factions) {
    const meta = FACTION_META[faction.factionName];
    const starting = gameData.countries.filter((country) => country.faction === faction.factionName).map((country) => countryLabel(country.name)).join(" · ");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "faction-option";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(!selectedFaction));
    button.style.setProperty("--faction", meta.color);
    button.style.setProperty("--accent", meta.accent);
    button.innerHTML = `<img src="${asset(meta.flag)}" alt=""><span><strong>${escapeHtml(meta.short)}</strong><small>${escapeHtml(starting)}</small></span>`;
    button.addEventListener("click", () => {
      selectedFaction = faction.factionName;
      $$(".faction-option", grid).forEach((item) => item.setAttribute("aria-checked", String(item === button)));
    });
    grid.append(button);
    if (!selectedFaction) selectedFaction = faction.factionName;
  }
  const objectives = $("#objective-select");
  objectives.innerHTML = Object.entries(OBJECTIVES).map(([id, item]) => `<option value="${id}">${escapeHtml(item.title)}</option>`).join("");
}

function startCampaign() {
  sessionSaveBaseline = localStorage.getItem(SAVE_KEY);
  gameState = newGame(gameData, {
    playerFaction: selectedFaction,
    heroName: $("#hero-name").value.trim() || "General",
    objective: $("#objective-select").value,
    difficulty: $("#difficulty-select").value,
  });
  selectedCountry = gameData.factions.find((faction) => faction.factionName === selectedFaction)?.capitalCountry || null;
  autosave();
  showScreen("game-screen");
}

function prepareMapGeometry() {
  for (const range of gameData.map.countries) {
    const counts = new Map();
    const indices = gameData.map.indices.slice(range.indexStart, range.indexStart + range.indexLength);
    for (let index = 0; index < indices.length; index += 3) {
      const triangle = [indices[index], indices[index + 1], indices[index + 2]];
      for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]) {
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    countryEdges.push([...counts.entries()].filter(([, count]) => count === 1).map(([key]) => key.split(":").map(Number)));
  }
}

function resizeMap() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = hitCanvas.width = width;
  canvas.height = hitCanvas.height = height;
}

function logicalSize() {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  return { width: canvas.width / ratio, height: canvas.height / ratio, ratio };
}

function pointOnMap(vertex, width, height) {
  return projectMapPoint(vertex, gameData.map.halfSize, width, height);
}

function setWorldTransform(target, width, height, ratio) {
  target.setTransform(ratio, 0, 0, ratio, 0, 0);
  target.translate(width / 2 + mapView.panX, height / 2 + mapView.panY);
  target.scale(mapView.zoom, mapView.zoom);
  target.translate(-width / 2, -height / 2);
}

function countryColor(name, index) {
  const country = gameState?.countries[name];
  if (!country) {
    const vertex = gameData.map.vertices[gameData.map.countries[index].vertexStart];
    return `rgb(${vertex[2]} ${vertex[3]} ${vertex[4]})`;
  }
  if (country.nukedUntil > gameState.year) return "#050505";
  if (battleColorOverride?.country === name) return battleColorOverride.owner ? FACTION_META[battleColorOverride.owner].color : "#161d27";
  return country.owner ? FACTION_META[country.owner].color : "#161d27";
}

function traceTriangles(target, range, width, height) {
  const indices = gameData.map.indices;
  target.beginPath();
  for (let cursor = range.indexStart; cursor < range.indexStart + range.indexLength; cursor += 3) {
    const a = pointOnMap(gameData.map.vertices[indices[cursor]], width, height);
    const b = pointOnMap(gameData.map.vertices[indices[cursor + 1]], width, height);
    const c = pointOnMap(gameData.map.vertices[indices[cursor + 2]], width, height);
    target.moveTo(a[0], a[1]); target.lineTo(b[0], b[1]); target.lineTo(c[0], c[1]); target.closePath();
  }
}

function traceEdges(target, edges, width, height) {
  target.beginPath();
  for (const [first, second] of edges) {
    const a = pointOnMap(gameData.map.vertices[first], width, height);
    const b = pointOnMap(gameData.map.vertices[second], width, height);
    target.moveTo(a[0], a[1]); target.lineTo(b[0], b[1]);
  }
}

function drawMap() {
  if (!gameData || !canvas.width) return;
  const { width, height, ratio } = logicalSize();
  context.setTransform(1, 0, 0, 1, 0, 0);
  const gradient = context.createRadialGradient(canvas.width * .5, canvas.height * .45, 0, canvas.width * .5, canvas.height * .5, canvas.width * .65);
  gradient.addColorStop(0, "#15417a"); gradient.addColorStop(.65, "#071d45"); gradient.addColorStop(1, "#020a17");
  context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height);
  hitContext.setTransform(1, 0, 0, 1, 0, 0); hitContext.fillStyle = "#000"; hitContext.fillRect(0, 0, hitCanvas.width, hitCanvas.height);
  setWorldTransform(context, width, height, ratio);
  setWorldTransform(hitContext, width, height, ratio);

  gameData.map.countries.forEach((range, index) => {
    traceTriangles(context, range, width, height);
    context.fillStyle = countryColor(range.name, index);
    context.fill();
    const hitId = index + 1;
    traceTriangles(hitContext, range, width, height);
    hitContext.fillStyle = encodeHitColor(hitId);
    hitContext.fill();
  });

  gameData.map.countries.forEach((range, index) => {
    traceEdges(context, countryEdges[index], width, height);
    context.strokeStyle = range.name === selectedCountry ? "#ffd04b" : "rgba(164, 207, 241, .5)";
    context.lineWidth = (range.name === selectedCountry ? 2.4 : .7) / mapView.zoom;
    context.stroke();
  });

  if (gameState) {
    context.font = `${10 / mapView.zoom}px Segoe UI`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (const faction of gameData.factions) {
      const capital = gameData.map.countries.find((country) => country.name === faction.capitalCountry);
      if (!capital) continue;
      const marker = CAPITAL_MARKER_OVERRIDES[capital.name] || capital.center;
      const center = pointOnMap(marker, width, height);
      context.fillStyle = "#ffe27d";
      context.fillText("★", center[0], center[1]);
    }
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  hitContext.setTransform(1, 0, 0, 1, 0, 0);
}

function pickCountry(event) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const x = Math.floor((event.clientX - rect.left) * ratio);
  const y = Math.floor((event.clientY - rect.top) * ratio);
  const pixel = hitContext.getImageData(x, y, 1, 1).data;
  // The complementary channels let us recover the ID after vector
  // anti-aliasing blends a narrow country triangle with the black backdrop.
  const index = decodeHitColor(pixel) - 1;
  if (index >= 0 && index < gameData.map.countries.length) {
    selectedCountry = gameData.map.countries[index].name;
    renderAll();
  }
}

function unitsMarkup(view) {
  if (!view.units) return `<div class="redacted">Garrison classified — gather intelligence to reveal it.</div>`;
  return `<div class="unit-grid">${Object.entries(UNIT_TYPES).map(([id, unit]) => `<div class="unit-tile"><img src="${asset(unit.icon)}" alt=""><strong>${Number(view.units[id]).toLocaleString()}</strong><span>${unit.label}</span></div>`).join("")}</div>`;
}

function renderCountryPanel() {
  const panel = $("#country-panel");
  if (!gameState || !selectedCountry) {
    panel.classList.remove("has-selection");
    panel.innerHTML = `<div class="empty-selection"><span class="crosshair">⌖</span><h2>Select a country</h2><p>Inspect its garrison, resource, infrastructure, and available orders.</p></div>`;
    return;
  }
  panel.classList.add("has-selection");
  const source = gameData.countries.find((country) => country.name === selectedCountry);
  const country = gameState.countries[selectedCountry];
  const view = publicCountryView(gameState, selectedCountry);
  const ownerMeta = country.owner ? FACTION_META[country.owner] : { color: "#35404c", accent: "#bdc6cc", short: country.nukedUntil > gameState.year ? "Nuclear exclusion zone" : "Neutral" };
  const resource = RESOURCE_NAMES[source.countryResource] || "Unknown";
  const upgradePills = view.upgrades?.length ? view.upgrades.map((id) => `<span>${escapeHtml(upgradeById(id)?.short || upgradeById(id)?.title || `Upgrade ${id}`)}</span>`).join("") : `<span>None built</span>`;
  const own = country.owner === gameState.playerFaction;
  const hostile = country.owner && !own;
  const attackable = !own && country.nukedUntil <= gameState.year;
  const canPurchaseHere = own && canBuyIn(gameData, gameState, gameState.playerFaction, selectedCountry);
  const boardableShips = own ? gameState.queue.filter((action) => action.type === "move" && action.unitType === "ships"
    && action.faction === gameState.playerFaction && action.from === selectedCountry && availableBoardingCapacity(gameState, gameState.playerFaction, action.id) > 0) : [];
  panel.style.setProperty("--owner", ownerMeta.color);
  panel.style.setProperty("--accent", ownerMeta.accent);
  panel.innerHTML = `
    <div class="country-head"><button id="close-country" class="country-close" aria-label="Close country panel">×</button><span class="country-owner">${escapeHtml(ownerMeta.short)}</span><h2 class="country-name">${escapeHtml(countryLabel(selectedCountry))}</h2><div class="country-resource"><img src="${asset(RESOURCE_IMAGES[source.countryResource])}" alt=""><span>${escapeHtml(resource)} · $${source.cashPerTurn}/year<small>${escapeHtml(resourceBonusText(selectedCountry, Boolean(view.upgrades)))}</small></span></div></div>
    <div class="country-actions">
      ${own ? `<button id="move-action">Move / Attack</button><button id="buy-action" ${canPurchaseHere ? "" : "disabled title=\"Build a Supply Center to buy units here\""}>Buy Units</button><button id="country-upgrade-action">Upgrades</button><button id="country-info-action">Country Info</button>${boardableShips.length ? `<button id="board-action" class="transport-action">Board Troops <span>${boardableShips.length}</span></button>` : ""}` : ""}
      ${hostile ? `<button id="spy-country-action">Spy</button>` : ""}${attackable ? `<button id="attack-country-action" class="attack">Attack Country</button>` : ""}
    </div>
    <section class="panel-section"><h3>Garrison</h3>${unitsMarkup(view)}</section>
    <section class="panel-section"><h3>Infrastructure</h3>${view.upgrades ? `<div class="upgrade-pills">${upgradePills}</div>` : `<div class="redacted">Infrastructure classified</div>`}</section>
    <section class="panel-section"><h3>Strategic data</h3><div class="upgrade-pills"><span>${escapeHtml(source.hasSeaBorder ? "Sea border" : "Landlocked")}</span><span>${source.adjoiningCountries.length} borders</span>${country.nukedUntil > gameState.year ? `<span>Uninhabitable until ${country.nukedUntil}</span>` : ""}</div></section>`;
  $("#move-action")?.addEventListener("click", () => openMoveDialog(selectedCountry));
  $("#close-country")?.addEventListener("click", () => { selectedCountry = null; renderAll(); });
  $("#buy-action")?.addEventListener("click", () => openBuyDialog(selectedCountry));
  $("#country-upgrade-action")?.addEventListener("click", () => openCountryUpgrades(selectedCountry));
  $("#country-info-action")?.addEventListener("click", () => openCountryInfo(selectedCountry));
  $("#board-action")?.addEventListener("click", () => openBoardTroopsDialog(boardableShips));
  $("#spy-country-action")?.addEventListener("click", () => openSpyDialog(selectedCountry));
  $("#attack-country-action")?.addEventListener("click", () => openAttackTargetDialog(selectedCountry));
}

function renderStatus() {
  if (!gameState) return;
  const factionName = gameState.playerFaction;
  const meta = FACTION_META[factionName];
  $("#status-flag").src = asset(meta.flag);
  $("#status-faction").textContent = meta.short;
  $("#status-general").textContent = `${gameState.factions[factionName].general.name} · Rank ${gameState.factions[factionName].general.level}`;
  $("#status-year").textContent = gameState.year;
  $("#status-countries").textContent = Object.values(gameState.countries).filter((country) => country.owner === factionName).length;
  $("#status-cash").textContent = `$${gameState.factions[factionName].cash.toLocaleString()}`;
  $("#queue-count").textContent = gameState.queue.filter((action) => action.faction === factionName).length;
}

function renderAll() {
  if (!gameState) return;
  renderStatus();
  renderCountryPanel();
  drawMap();
}

function openDialog(kicker, title, content, ready) {
  const dialog = $("#command-dialog");
  $("#dialog-kicker").textContent = kicker;
  $("#dialog-title").textContent = title;
  $("#dialog-content").innerHTML = content;
  if (!dialog.open) dialog.showModal();
  const root = $("#dialog-content");
  ready?.(root);
  requestAnimationFrame(() => $("select, input, button:not(:disabled)", root)?.focus());
}

function closeDialog() {
  const dialog = $("#command-dialog");
  if (dialog.open) dialog.close();
}

function openBuyDialog(countryName) {
  const purchasable = Object.entries(UNIT_TYPES).map(([id, unit]) => ({
    id,
    unit,
    cost: unitCost(gameData, gameState, gameState.playerFaction, countryName, id),
    capacity: maxPurchasableUnits(gameData, gameState, gameState.playerFaction, countryName, id),
  })).filter((item) => item.capacity > 0);
  if (!purchasable.length) return notify("No units can be bought here with the available funds.", "bad");
  const options = purchasable.map(({ id, unit, cost, capacity }) => `<option value="${id}" data-limit="${capacity}">${unit.label} — $${cost} each · max ${capacity}</option>`).join("");
  openDialog(countryLabel(countryName), "Buy Units", `<form id="buy-form" class="dialog-form"><label>Unit type<select id="buy-unit">${options}</select></label><label>Quantity<input id="buy-quantity" type="number" inputmode="numeric" min="1" step="1" value="1"></label><p id="buy-total" class="order-summary"></p><button class="primary-button" type="submit">Queue purchase</button></form>`, (root) => {
    const update = (clampQuantity = false) => {
      const select = $("#buy-unit", root);
      const quantityInput = $("#buy-quantity", root);
      const limit = Number(select.selectedOptions[0]?.dataset.limit || 0);
      quantityInput.max = limit;
      if (clampQuantity && Number(quantityInput.value) > limit) quantityInput.value = limit;
      const quantity = Number(quantityInput.value);
      const validQuantity = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= limit;
      const total = validQuantity ? unitCost(gameData, gameState, gameState.playerFaction, countryName, select.value) * quantity : 0;
      $("#buy-total", root).textContent = validQuantity ? `Available: ${limit} · Order total: $${total.toLocaleString()}` : `Enter a whole number from 1 to ${limit}.`;
    };
    $("#buy-unit", root).addEventListener("change", () => update(true));
    $("#buy-quantity", root).addEventListener("input", () => update());
    update(true);
    $("#buy-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      if (withRules(() => queueBuy(gameData, gameState, gameState.playerFaction, countryName, $("#buy-unit", root).value, $("#buy-quantity", root).value))) closeDialog();
    });
  });
}

function openMoveDialog(fromName) {
  const unitOptions = Object.entries(UNIT_TYPES).map(([id, unit]) => ({ id, unit, available: availableUnitCount(gameState, gameState.playerFaction, fromName, id) })).filter((item) => item.available > 0)
    .map(({ id, unit, available }) => `<option value="${id}" data-available="${available}">${unit.label} (${available} available)</option>`).join("");
  if (!unitOptions) return notify("No units are available to move.", "bad");
  openDialog(countryLabel(fromName), "Move / Attack", `<form id="move-form" class="dialog-form"><label>Unit type<select id="move-unit">${unitOptions}</select></label><label>Target<select id="move-target"></select></label><label>Quantity<input id="move-quantity" type="number" inputmode="numeric" min="1" step="1" value="1"></label><p id="move-help" class="order-summary"></p><button id="move-submit" class="primary-button" type="submit">Queue order</button></form>`, (root) => {
    const updateTargets = () => {
      const unitType = $("#move-unit", root).value;
      const target = $("#move-target", root);
      target.innerHTML = countriesAlphabetically(gameData.countries.filter((country) => canReach(gameData, gameState, gameState.playerFaction, fromName, country.name, unitType))).map((country) => {
        const controlled = gameState.countries[country.name].owner === gameState.playerFaction;
        return `<option value="${country.name}" class="${controlled ? "controlled-option" : "uncontrolled-option"}">${escapeHtml(countryLabel(country.name))}${controlled ? " — move" : " — attack"}</option>`;
      }).join("");
      const available = availableUnitCount(gameState, gameState.playerFaction, fromName, unitType);
      const quantity = $("#move-quantity", root);
      quantity.max = available;
      if (Number(quantity.value) > available) quantity.value = available;
      target.disabled = !target.options.length;
      $("#move-submit", root).disabled = !target.options.length;
      $("#move-help", root).textContent = target.options.length ? `${available} uncommitted ${UNIT_TYPES[unitType].label.toLowerCase()} can be ordered.` : "No valid target is in range for this unit.";
    };
    $("#move-unit", root).addEventListener("change", updateTargets); updateTargets();
    $("#move-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      let queuedAction;
      const unitType = $("#move-unit", root).value;
      if (withRules(() => { queuedAction = queueMove(gameData, gameState, gameState.playerFaction, fromName, $("#move-target", root).value, unitType, $("#move-quantity", root).value); })) {
        if (unitType === "ships" && availableBoardingCapacity(gameState, gameState.playerFaction, queuedAction.id) > 0) openBoardTroopsDialog([queuedAction]);
        else closeDialog();
      }
    });
  });
}

function attackSourcesFor(targetName) {
  return countriesAlphabetically(gameData.countries.filter((country) => gameState.countries[country.name].owner === gameState.playerFaction
    && Object.keys(UNIT_TYPES).some((unitType) => availableUnitCount(gameState, gameState.playerFaction, country.name, unitType) > 0
      && canReach(gameData, gameState, gameState.playerFaction, country.name, targetName, unitType))));
}

function openAttackTargetDialog(targetName) {
  const target = gameState.countries[targetName];
  if (!target || target.owner === gameState.playerFaction) return notify("Select a country outside your control to plan an attack.", "bad");
  const sources = attackSourcesFor(targetName);
  if (!sources.length) return notify(`No controlled country has forces able to reach ${countryLabel(targetName)}.`, "bad");
  const queuedForTarget = () => gameState.queue.filter((action) => action.type === "move" && action.faction === gameState.playerFaction && action.to === targetName);
  openDialog("Target-first operations", `Attack ${countryLabel(targetName)}`, `<div id="attack-planner"></div>`, (root) => {
    const render = (preferredSource = null) => {
      const currentSources = attackSourcesFor(targetName);
      const queued = queuedForTarget();
      const sourceOptions = currentSources.map((country) => `<option value="${country.name}" ${country.name === preferredSource ? "selected" : ""}>${escapeHtml(countryLabel(country.name))}</option>`).join("");
      const queuedMarkup = queued.length ? `<h3 class="dialog-section-title">Forces already committed</h3><div class="attack-commitments">${queued.map((action) => `<div><span>${escapeHtml(countryLabel(action.from))}</span><strong>${action.quantity} ${UNIT_TYPES[action.unitType].label.toLowerCase()}${action.carriedTroops ? ` + ${action.carriedTroops} troops aboard` : ""}</strong>${action.unitType === "ships" && availableBoardingCapacity(gameState, gameState.playerFaction, action.id) > 0 ? `<button type="button" data-attack-board="${action.id}">Board troops</button>` : ""}</div>`).join("")}</div>` : "";
      $("#attack-planner", root).innerHTML = `${queuedMarkup}<form id="attack-form" class="dialog-form"><label>Attack from<select id="attack-source">${sourceOptions}</select></label><label>Unit type<select id="attack-unit"></select></label><label>Quantity<input id="attack-quantity" type="number" inputmode="numeric" min="1" step="1" value="1"></label><p id="attack-help" class="order-summary"></p><button id="attack-submit" class="primary-button" type="submit">Queue this force</button></form><p class="section-help attack-planner-help">Queue forces from several countries here; close the planner when the attack is ready.</p>`;
      const sourceSelect = $("#attack-source", root);
      const unitSelect = $("#attack-unit", root);
      const quantity = $("#attack-quantity", root);
      const updateUnits = () => {
        const sourceName = sourceSelect.value;
        const units = Object.entries(UNIT_TYPES).filter(([unitType]) => availableUnitCount(gameState, gameState.playerFaction, sourceName, unitType) > 0
          && canReach(gameData, gameState, gameState.playerFaction, sourceName, targetName, unitType));
        unitSelect.innerHTML = units.map(([unitType, meta]) => `<option value="${unitType}">${meta.label} (${availableUnitCount(gameState, gameState.playerFaction, sourceName, unitType)} available)</option>`).join("");
        updateQuantity();
      };
      const updateQuantity = () => {
        const available = unitSelect.value ? availableUnitCount(gameState, gameState.playerFaction, sourceSelect.value, unitSelect.value) : 0;
        quantity.max = available;
        if (Number(quantity.value) > available || Number(quantity.value) < 1) quantity.value = Math.max(1, available);
        $("#attack-submit", root).disabled = !available;
        $("#attack-help", root).textContent = available ? `${available} uncommitted ${UNIT_TYPES[unitSelect.value].label.toLowerCase()} can attack from ${countryLabel(sourceSelect.value)}.` : "No reachable units remain in this country.";
      };
      sourceSelect.addEventListener("change", updateUnits);
      unitSelect.addEventListener("change", updateQuantity);
      $("#attack-form", root).addEventListener("submit", (event) => {
        event.preventDefault();
        const sourceName = sourceSelect.value;
        const unitType = unitSelect.value;
        let queuedAction;
        if (withRules(() => { queuedAction = queueMove(gameData, gameState, gameState.playerFaction, sourceName, targetName, unitType, quantity.value); })) {
          notify(`${UNIT_TYPES[unitType].label} committed from ${countryLabel(sourceName)}. Add another force or close the planner.`, "good");
          if (unitType === "ships" && availableBoardingCapacity(gameState, gameState.playerFaction, queuedAction.id) > 0) {
            openBoardTroopsDialog([queuedAction], () => openAttackTargetDialog(targetName));
          } else render(sourceName);
        }
      });
      $$('[data-attack-board]', root).forEach((button) => button.addEventListener("click", () => {
        const action = gameState.queue.find((item) => item.id === button.dataset.attackBoard);
        if (action) openBoardTroopsDialog([action], () => openAttackTargetDialog(targetName));
      }));
      updateUnits();
    };
    render(sources[0].name);
  });
}

function openBoardTroopsDialog(actions, onDone = null) {
  const routes = actions.filter((action) => availableBoardingCapacity(gameState, gameState.playerFaction, action.id) > 0);
  if (!routes.length) return notify("No queued ships have free troop capacity.", "bad");
  const multiplier = navalTransportMultiplier(gameState, gameState.playerFaction);
  const options = routes.map((action) => `<option value="${action.id}">${escapeHtml(countryLabel(action.from))} → ${escapeHtml(countryLabel(action.to))} · ${action.quantity} ships</option>`).join("");
  openDialog("Naval transport", "Board Troops", `<form id="board-form" class="dialog-form"><div class="intel-panel">Each ship carries ${multiplier} troop${multiplier === 1 ? "" : "s"}${multiplier === 2 ? " with Sea Carrier" : ""}. The troops land with the fleet if it wins.</div><label>Queued fleet<select id="board-route">${options}</select></label><label>Troops to board<input id="board-quantity" type="number" inputmode="numeric" min="1" step="1" value="1"></label><p id="board-help" class="order-summary"></p><div class="dialog-actions"><button class="primary-button" type="submit">Board troops</button><button id="board-later" class="secondary-button" type="button">Not now</button></div></form>`, (root) => {
    const update = () => {
      const actionId = $("#board-route", root).value;
      const capacity = availableBoardingCapacity(gameState, gameState.playerFaction, actionId);
      const input = $("#board-quantity", root);
      input.max = capacity;
      if (Number(input.value) > capacity) input.value = capacity;
      $("#board-help", root).textContent = `${capacity} troop space${capacity === 1 ? "" : "s"} available on this fleet.`;
    };
    $("#board-route", root).addEventListener("change", update);
    $("#board-later", root).addEventListener("click", () => { if (onDone) onDone(); else closeDialog(); });
    $("#board-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      if (withRules(() => boardTroops(gameState, gameState.playerFaction, $("#board-route", root).value, $("#board-quantity", root).value))) {
        if (onDone) onDone(); else closeDialog();
      }
    });
    update();
  });
}

function upgradeCard(upgrade, mode, countryName = null, status = "available") {
  const description = localized(`${upgrade.title} Description`, "Recovered strategic upgrade.");
  const complete = status !== "available";
  const label = status === "queued" ? "Queued ✓" : status === "built" ? "Built ✓" : `Build${countryName ? ` in ${escapeHtml(countryLabel(countryName))}` : ""}`;
  return `<article class="action-card ${complete ? "action-complete" : ""}"><img src="${asset(upgrade.image)}" alt=""><div><h3>${escapeHtml(upgrade.short || upgrade.title)} <span class="price">$${upgrade.cost.toLocaleString()}</span></h3><p>${escapeHtml(description)}</p><button type="button" data-upgrade="${upgrade.id}" data-mode="${mode}" ${complete || gameState.factions[gameState.playerFaction].cash < upgrade.cost ? "disabled" : ""}>${label}</button></div></article>`;
}

function openCountryUpgrades(countryName) {
  const queuedIds = gameState.queue.filter((action) => action.type === "country-upgrade" && action.faction === gameState.playerFaction && action.country === countryName).map((action) => action.upgradeId);
  const upgrades = [...new Map([...availableUpgrades(gameData, gameState, gameState.playerFaction, "country", countryName), ...queuedIds.map(upgradeById)].filter(Boolean).map((upgrade) => [upgrade.id, upgrade])).values()];
  openDialog(countryLabel(countryName), "Country Upgrades", `<div id="country-upgrade-list"></div>`, (root) => {
    const render = () => {
      const queued = new Set(gameState.queue.filter((action) => action.type === "country-upgrade" && action.faction === gameState.playerFaction && action.country === countryName).map((action) => action.upgradeId));
      $("#country-upgrade-list", root).innerHTML = upgrades.length ? `<div class="dialog-grid">${upgrades.map((upgrade) => upgradeCard(upgrade, "country", countryName, queued.has(upgrade.id) ? "queued" : "available")).join("")}</div>` : `<p>Every available upgrade has already been built here.</p>`;
      $$('[data-mode="country"]', root).forEach((button) => button.addEventListener("click", () => {
        if (withRules(() => queueUpgrade(gameData, gameState, gameState.playerFaction, countryName, Number(button.dataset.upgrade)))) render();
      }));
    };
    render();
  });
}

function openWorldUpgrades() {
  const upgrades = availableUpgrades(gameData, gameState, gameState.playerFaction, "world");
  openDialog("Faction research", "Faction Upgrades", `<div id="world-upgrade-list"></div>`, (root) => {
    const render = () => {
      const faction = gameState.factions[gameState.playerFaction];
      const naval = faction.unitUpgrades?.find((item) => ["sea-carrier", "advanced-battleship"].includes(item));
      const worldMarkup = upgrades.length ? `<div class="dialog-grid">${upgrades.map((upgrade) => upgradeCard(upgrade, "world", null, faction.worldUpgrades.includes(upgrade.id) ? "built" : "available")).join("")}</div>` : `<p>All faction world upgrades have been completed.</p>`;
      const doctrineCard = (id, title, image, description) => `<article class="action-card ${naval === id ? "action-complete" : ""}"><img src="${asset(image)}" alt=""><div><h3>${title}</h3><p>${description}</p><button type="button" data-doctrine="${id}" ${naval ? "disabled" : ""}>${naval === id ? "Selected ✓" : naval ? "Alternative locked" : "Select doctrine"}</button></div></article>`;
      $("#world-upgrade-list", root).innerHTML = `<h3 class="dialog-section-title">World research</h3>${worldMarkup}<h3 class="dialog-section-title">Naval unit upgrade</h3><p class="section-help">Choose one permanent ship specialization.</p><div class="dialog-grid">${doctrineCard("sea-carrier", "Sea Carrier", "SeaCarrierImage.png", "Each ship can carry two troops instead of one.")}${doctrineCard("advanced-battleship", "Advanced Battleship", "AdvancedBattleshipImage.png", "Ships gain 50% attack and defence strength.")}</div>`;
      $$('[data-mode="world"]', root).forEach((button) => button.addEventListener("click", () => {
        if (withRules(() => buyWorldUpgrade(gameData, gameState, gameState.playerFaction, Number(button.dataset.upgrade)))) render();
      }));
      $$('[data-doctrine]', root).forEach((button) => button.addEventListener("click", () => {
        if (withRules(() => chooseNavalDoctrine(gameState, gameState.playerFaction, button.dataset.doctrine))) render();
      }));
    };
    render();
  });
}

function openCountryInfo(countryName) {
  const source = gameData.countries.find((country) => country.name === countryName);
  const state = gameState.countries[countryName];
  openDialog("Country intelligence", countryLabel(countryName), `<div class="dialog-grid"><article class="action-card"><img src="${asset(RESOURCE_IMAGES[source.countryResource])}" alt=""><div><h3>${RESOURCE_NAMES[source.countryResource]}</h3><p>${escapeHtml(localized(`${RESOURCE_NAMES[source.countryResource]} Description`, "Strategic national resource."))}</p><span class="price">${escapeHtml(resourceBonusText(countryName))} · Base income $${source.cashPerTurn}/year</span></div></article><article class="action-card"><img src="${asset("countryGarnisonImage.png")}" alt=""><div><h3>Operational borders</h3><p>${countriesAlphabetically(source.adjoiningCountries.map((name) => gameData.countries.find((country) => country.name === name)).filter(Boolean)).map((country) => countryLabel(country.name)).join(" · ")}</p><span>${source.hasSeaBorder ? "Sea access available" : "Landlocked"}</span></div></article></div><div class="intel-panel">${state.nukedUntil > gameState.year ? `Nuclear fallout prevents occupation until ${state.nukedUntil}.` : "Country is operational."}</div>`);
}

function openSpyDialog(defaultTarget = null) {
  const targets = countriesAlphabetically(gameData.countries.filter((country) => {
    const owner = gameState.countries[country.name].owner;
    return owner && owner !== gameState.playerFaction;
  }));
  if (!targets.length) return notify("No enemy countries remain.");
  const options = targets.map((country) => `<option value="${country.name}" ${country.name === defaultTarget ? "selected" : ""}>${escapeHtml(countryLabel(country.name))}</option>`).join("");
  const faction = gameState.factions[gameState.playerFaction];
  const strategic = `${faction.nukes > 0 ? `<article class="action-card"><img src="${asset("ManhattanProjectImage.png")}" alt=""><div><h3>Nuclear strike (${faction.nukes})</h3><p>Erase the target garrison, infrastructure, and control.</p><button type="button" data-weapon="nuke">Launch</button></div></article>` : ""}${faction.worldUpgrades.includes(17) ? `<article class="action-card"><img src="${asset("RailGunImage.png")}" alt=""><div><h3>Rail Gun</h3><p>Destroy roughly 85% of every defending unit. Ready ${faction.railGunReady <= gameState.year ? "now" : `in ${faction.railGunReady}`}.</p><button type="button" data-weapon="railgun" ${faction.railGunReady > gameState.year ? "disabled" : ""}>Fire</button></div></article>` : ""}`;
  const cards = Object.entries(SPY_ACTIONS).map(([id, action]) => `<article class="action-card"><img src="${asset(id === "intelligence" ? "IntelligenceImage.png" : id === "bribery" ? "BriberyImage.png" : "HitImage.png")}" alt=""><div><h3>${action.title} <span class="price">$${action.cost}</span></h3><p>${escapeHtml(localized(`Spy Action ${action.title} Description`, action.description))}</p><button type="button" data-spy="${id}" ${action.upgrade && !faction.worldUpgrades.includes(action.upgrade) ? "disabled" : ""}>Use</button></div></article>`).join("");
  openDialog("Immediate operations", "Spying & Strategic Weapons", `<label>Target<select id="spy-target">${options}</select></label><div class="dialog-grid" style="margin-top:14px">${cards}${strategic}</div>`, (root) => {
    $$('[data-spy]', root).forEach((button) => button.addEventListener("click", () => { if (withRules(() => useSpyAction(gameData, gameState, gameState.playerFaction, button.dataset.spy, $("#spy-target", root).value))) closeDialog(); }));
    $$('[data-weapon]', root).forEach((button) => button.addEventListener("click", () => { if (withRules(() => useStrategicWeapon(gameState, gameState.playerFaction, button.dataset.weapon, $("#spy-target", root).value))) closeDialog(); }));
  });
}

function actionDescription(action) {
  if (action.type === "buy") return `Buy ${action.quantity} ${UNIT_TYPES[action.unitType].label.toLowerCase()} in ${countryLabel(action.country)}`;
  if (action.type === "move") return `${action.quantity} ${UNIT_TYPES[action.unitType].label.toLowerCase()}${action.carriedTroops ? ` carrying ${action.carriedTroops} troops` : ""}: ${countryLabel(action.from)} → ${countryLabel(action.to)}`;
  if (action.type === "country-upgrade") return `Build ${upgradeById(action.upgradeId)?.title} in ${countryLabel(action.country)}`;
  return action.type;
}

function openQueue() {
  const actions = gameState.queue.filter((action) => action.faction === gameState.playerFaction);
  openDialog("Pending orders", "Action Queue", actions.length ? `<div class="queue-list">${actions.map((action) => `<div class="queue-item"><div><strong>${escapeHtml(actionDescription(action))}</strong><span>${action.cost ? ` · $${action.cost} reserved` : action.unitType === "ships" ? ` · ${availableBoardingCapacity(gameState, gameState.playerFaction, action.id)} troop spaces free` : ""}</span></div><div class="queue-buttons">${action.unitType === "ships" && availableBoardingCapacity(gameState, gameState.playerFaction, action.id) > 0 ? `<button type="button" data-board="${action.id}">Board</button>` : ""}<button type="button" data-cancel="${action.id}">Cancel</button></div></div>`).join("")}</div>` : `<p>No orders are queued. Spy actions are processed immediately.</p>`, (root) => {
    $$('[data-cancel]', root).forEach((button) => button.addEventListener("click", () => { if (withRules(() => cancelAction(gameState, button.dataset.cancel))) { closeDialog(); openQueue(); } }));
    $$('[data-board]', root).forEach((button) => button.addEventListener("click", () => {
      const action = gameState.queue.find((item) => item.id === button.dataset.board);
      if (action) openBoardTroopsDialog([action]);
    }));
  });
}

function openObjective() {
  const faction = gameState.factions[gameState.playerFaction];
  const controlledCountries = countriesAlphabetically(gameData.countries.filter((country) => gameState.countries[country.name].owner === gameState.playerFaction));
  const owned = controlledCountries.length;
  const forceCards = controlledCountries.map((country) => {
    const units = gameState.countries[country.name].units;
    return `<article class="force-country"><button type="button" data-force-country="${country.name}">${escapeHtml(countryLabel(country.name))}</button><div>${Object.entries(UNIT_TYPES).map(([unitType, meta]) => `<span title="${meta.label}"><img src="${asset(meta.icon)}" alt=""><b>${units[unitType].toLocaleString()}</b><small>${meta.label}</small></span>`).join("")}</div></article>`;
  }).join("");
  const log = gameState.log.slice(0, 18).map((item) => `<div class="log-item"><span>${item.year}</span><strong>${escapeHtml(item.message)}</strong></div>`).join("");
  openDialog(faction.general.name, OBJECTIVES[gameState.objective].title, `<p>${escapeHtml(OBJECTIVES[gameState.objective].description)}</p><div class="intel-panel">Rank ${faction.general.level} · ${faction.conquests} conquests · ${owned} countries · $${faction.cash.toLocaleString()}</div><h3 class="dialog-section-title">Controlled-country forces</h3><p class="section-help">Every garrison under your command, sorted A–Z. Select a country name to find it on the map.</p><div class="force-overview">${forceCards}</div><h3 class="dialog-section-title">Campaign log</h3><div class="log-list">${log}</div>`, (root) => {
    $$('[data-force-country]', root).forEach((button) => button.addEventListener("click", () => {
      selectedCountry = button.dataset.forceCountry;
      closeDialog();
      renderAll();
    }));
  });
}

function openSettings() {
  openDialog("Game options", "Settings", `<form class="settings-form"><label class="setting-row"><span><strong>Sound effects</strong><small>Original marching and battle sounds.</small></span><input id="sound-setting" type="checkbox" ${preferences.soundFx ? "checked" : ""}></label><label class="setting-row"><span><strong>Combat animations</strong><small>Zoom to every battle involving your faction.</small></span><input id="animation-setting" type="checkbox" ${preferences.combatAnimations ? "checked" : ""}></label><p class="section-help">During a battle, tap Show result to finish the current animation or Skip all to jump through the remaining reports.</p></form>`, (root) => {
    $("#sound-setting", root).addEventListener("change", (event) => { preferences.soundFx = event.target.checked; savePreferences(); if (!preferences.soundFx) stopBattleAudio(); });
    $("#animation-setting", root).addEventListener("change", (event) => { preferences.combatAnimations = event.target.checked; savePreferences(); });
  });
}

function exitToMenu(saveCurrent) {
  if (saveCurrent) {
    autosave();
    sessionSaveBaseline = localStorage.getItem(SAVE_KEY);
  } else if (sessionSaveBaseline === null) localStorage.removeItem(SAVE_KEY);
  else localStorage.setItem(SAVE_KEY, sessionSaveBaseline);
  closeDialog();
  gameState = null;
  selectedCountry = null;
  mapView.zoom = 1;
  mapView.panX = mapView.panY = 0;
  showScreen("menu-screen");
}

function openExitPrompt() {
  openDialog("Leave campaign", "Return to Main Menu?", `<p>Save the current position before leaving the battlefield?</p><div class="dialog-actions exit-actions"><button id="save-exit" class="primary-button" type="button">Save & Exit</button><button id="discard-exit" class="secondary-button danger-button" type="button">Exit Without Saving</button><button id="stay-game" class="secondary-button" type="button">Stay in Game</button></div>`, (root) => {
    $("#save-exit", root).addEventListener("click", () => exitToMenu(true));
    $("#discard-exit", root).addEventListener("click", () => exitToMenu(false));
    $("#stay-game", root).addEventListener("click", closeDialog);
  });
}

function groupedPlayerBattles(events) {
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.country)) groups.set(event.country, { country: event.country, events: [], participants: [] });
    const group = groups.get(event.country);
    group.events.push(event);
    for (const faction of [event.defender, event.attacker]) {
      const key = faction || "__neutral__";
      if (!group.participants.some((item) => item.key === key)) group.participants.push({ key, faction });
    }
  }
  return [...groups.values()].filter((group) => group.events.some((event) => event.attacker === gameState.playerFaction || event.defender === gameState.playerFaction));
}

function battleParticipantMarkup(participant) {
  const meta = participant.faction ? FACTION_META[participant.faction] : { short: "Neutral", flag: "neutralFlag.png", color: "#67717b" };
  return `<article class="battle-faction" data-faction="${escapeHtml(participant.key)}" style="--faction-color:${meta.color}"><img src="${asset(meta.flag)}" alt=""><strong>${escapeHtml(meta.short)}</strong><span>In position</span></article>`;
}

async function waitBattle(milliseconds) {
  const started = performance.now();
  while (!battleSkipCurrent && !battleSkipAll && performance.now() - started < milliseconds) await delay(40);
}

async function animateMapView(target, milliseconds) {
  const start = { zoom: mapView.zoom, panX: mapView.panX, panY: mapView.panY };
  if (!preferences.combatAnimations || battleSkipAll) Object.assign(mapView, target);
  else {
    const started = performance.now();
    while (performance.now() - started < milliseconds && !battleSkipCurrent && !battleSkipAll) {
      const progress = Math.min(1, (performance.now() - started) / milliseconds);
      const eased = 1 - (1 - progress) ** 3;
      mapView.zoom = start.zoom + (target.zoom - start.zoom) * eased;
      mapView.panX = start.panX + (target.panX - start.panX) * eased;
      mapView.panY = start.panY + (target.panY - start.panY) * eased;
      drawMap();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    Object.assign(mapView, target);
  }
  drawMap();
}

function focusedMapView(countryName) {
  const range = gameData.map.countries.find((country) => country.name === countryName);
  const { width, height } = logicalSize();
  const point = pointOnMap(range.center, width, height);
  const zoom = width < 600 ? 2.35 : 2.8;
  return { zoom, panX: (width / 2 - point[0]) * zoom, panY: (height / 2 - point[1]) * zoom };
}

function battleResultText(group, finalOwner) {
  const player = gameState.playerFaction;
  const playerAttacked = group.events.some((event) => event.attacker === player);
  const playerDefended = group.events.some((event) => event.defender === player);
  if (finalOwner === player && playerAttacked) return `${FACTION_META[player].short} conquered ${countryLabel(group.country)}.`;
  if (finalOwner === player && playerDefended) return `${countryLabel(group.country)} held. The defence stands.`;
  if (playerAttacked) return `The attack on ${countryLabel(group.country)} was defeated.`;
  return `${countryLabel(group.country)} was lost to ${finalOwner ? FACTION_META[finalOwner].short : "neutral forces"}.`;
}

async function playBattleSequence(events) {
  const groups = groupedPlayerBattles(events);
  if (!groups.length || !preferences.combatAnimations) return;
  const overlay = $("#battle-sequence");
  const savedView = { zoom: mapView.zoom, panX: mapView.panX, panY: mapView.panY };
  const savedCountry = selectedCountry;
  battleSkipAll = false;
  overlay.hidden = false;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    battleSkipCurrent = false;
    const first = group.events[0];
    const finalOwner = gameState.countries[group.country].owner;
    battleColorOverride = { country: group.country, owner: first.defender };
    selectedCountry = group.country;
    renderCountryPanel();
    $("#battle-kicker").textContent = `Battle ${index + 1} of ${groups.length}`;
    $("#battle-title").textContent = countryLabel(group.country);
    $("#battle-route").textContent = group.events.map((event) => `${countryLabel(event.from)} → ${countryLabel(event.country)} · ${event.quantity} ${UNIT_TYPES[event.unitType].label.toLowerCase()}${event.carriedTroops ? ` + ${event.carriedTroops} troops aboard` : ""}`).join("  |  ");
    $("#battle-factions").innerHTML = group.participants.map(battleParticipantMarkup).join("");
    $("#battle-result").textContent = "Forces are marching into position…";
    $("#battle-progress-fill").style.width = "8%";
    playBattleSound("march", 0.78);
    await animateMapView(focusedMapView(group.country), 760);
    await waitBattle(720);
    if (!battleSkipAll && !battleSkipCurrent) {
      $("#battle-sequence").classList.add("battle-clash");
      $("#battle-result").textContent = "Battle joined — attack and defence are resolving…";
      $("#battle-progress-fill").style.width = "76%";
      playBattleSound(`attack${index % 4 + 1}`, 0.64);
      await waitBattle(1650);
    }
    stopBattleAudio();
    const resultWasRequested = battleSkipCurrent;
    battleSkipCurrent = false;
    battleColorOverride = { country: group.country, owner: finalOwner };
    drawMap();
    const winnerKey = finalOwner || "__neutral__";
    $$(".battle-faction", overlay).forEach((card) => {
      const won = card.dataset.faction === winnerKey;
      card.classList.toggle("winner", won);
      card.classList.toggle("fallen", !won);
      $("span", card).textContent = won ? "Holds the field" : "Defeated";
    });
    $("#battle-progress-fill").style.width = "100%";
    $("#battle-result").textContent = battleResultText(group, finalOwner);
    $("#battle-sequence").classList.remove("battle-clash");
    const playerLost = group.events.some((event) => event.attacker === gameState.playerFaction) && finalOwner !== gameState.playerFaction;
    if (playerLost) playBattleSound("failed", 0.72);
    if (!battleSkipAll) await waitBattle(resultWasRequested ? 1100 : 2200);
    else await delay(100);
  }
  stopBattleAudio();
  overlay.hidden = true;
  battleColorOverride = null;
  selectedCountry = savedCountry;
  renderCountryPanel();
  await animateMapView(savedView, battleSkipAll ? 0 : 520);
  battleSkipCurrent = battleSkipAll = false;
}

function buildManual() {
  $("#manual-content").innerHTML = `
    <p>Wargame is a turn-based strategy game. Every order you plan is queued for the end of the year; espionage is immediate. Expand from your faction's three starting countries, build an economy, and meet your chosen objective.</p>
    <h3>1. Tactical map</h3><p>Colored countries belong to factions; dark countries are neutral. Select one of your countries to move forces, buy units, build infrastructure, or inspect it. Drag the map to pan and use the wheel or zoom controls.</p>
    <h3>2. Moving, attacking, and naval transport</h3><p>Troops cross adjoining land borders. Ships travel between coastal countries. You can plan from either direction: select one of your countries and choose Move / Attack, or select an uncontrolled target and choose Attack Country to commit forces from several source countries. Target lists are sorted A–Z; italic entries are outside your control. After queuing a ship movement, board troops onto that fleet from the country panel, attack planner, or Action Queue. Each ship carries one troop, or two after selecting Sea Carrier. Planes, missiles, and commandos can reach distant targets.</p>
    <h3>3. Economy, resources, and buying</h3><p>Every controlled country pays cash each year and supplies its recovered national-resource bonus: Heavy Industry produces planes, Finance produces cash, Agriculture troops, Ore missiles, and Fishing ships. Petroleum discounts ships, planes, and missiles. A Power Plant doubles the local resource effect, and controlling more than nine countries with the same resource grants its synergy bonus at your capital. Units may be bought in original faction countries or anywhere with a Supply Center.</p>
    <h3>4. Combat</h3><p>Each faction has the original unit attack, defence, and cost profile recovered from the app. Generals, country defences, bribery, and upgrades modify combat. Battles involving your faction zoom to the contested country and replay with the preserved marching and combat sounds. Use Show result or Skip all to shorten the sequence.</p>
    <h3>5. Upgrades and spying</h3><p>Country upgrades include AWFDS, Supply Centers, Power Plants, and a faction-specific ability. World upgrades unlock decisive faction powers. Intelligence reveals a hidden garrison; Bribery halves its defence for the current year; 00 Agents unlock hits against rival generals.</p>
    <h3>6. General, forces, end turn, and saves</h3><p>The General view lists every controlled-country garrison A–Z, including troops, ships, planes, missiles, and commandos. End Turn lets all computer factions plan, then resolves purchases, construction, moves, resource grants, and battles. Income is collected and neutral armies grow. Campaigns autosave locally after every order and can also be saved from the toolbar.</p>`;
}

function checkEnding() {
  checkVictory(gameState);
  if (gameState.status === "playing") return;
  const victory = gameState.status === "victory";
  $("#ending").hidden = false;
  $("#ending").style.backgroundImage = `linear-gradient(rgba(0,0,0,.25),rgba(0,0,0,.72)), url("${asset(victory ? "victoryScreenBackground.png" : "defeatScreenBackground.png")}")`;
  $("#ending-title").textContent = victory ? "Victory" : "Defeat";
  $("#ending-copy").textContent = victory ? "Your objective is complete. The world has a new order." : "Your last country has fallen. History belongs to another faction.";
}

function bindEvents() {
  $("#new-game-button").addEventListener("click", () => showScreen("setup-screen"));
  $("#resume-button").addEventListener("click", () => { const saved = readSave(); if (saved) { sessionSaveBaseline = localStorage.getItem(SAVE_KEY); gameState = saved; selectedCountry = gameData.factions.find((faction) => faction.factionName === gameState.playerFaction)?.capitalCountry; showScreen("game-screen"); } });
  $("#manual-button").addEventListener("click", () => showScreen("manual-screen"));
  $("#about-button").addEventListener("click", () => showScreen("about-screen"));
  $$('[data-screen]').forEach((button) => button.addEventListener("click", () => showScreen(button.dataset.screen)));
  $("#setup-form").addEventListener("submit", (event) => { event.preventDefault(); startCampaign(); });
  $(".dialog-close").addEventListener("click", closeDialog);
  $("#command-dialog").addEventListener("click", (event) => { if (event.target === event.currentTarget) closeDialog(); });
  $("#queue-button").addEventListener("click", openQueue);
  $("#world-upgrades-button").addEventListener("click", openWorldUpgrades);
  $("#espionage-button").addEventListener("click", () => openSpyDialog(selectedCountry));
  $("#objective-button").addEventListener("click", openObjective);
  $("#save-button").addEventListener("click", () => { autosave(); sessionSaveBaseline = localStorage.getItem(SAVE_KEY); notify("Campaign saved in this browser.", "good"); });
  $("#settings-button").addEventListener("click", openSettings);
  $("#exit-button").addEventListener("click", openExitPrompt);
  $("#end-turn-button").addEventListener("click", async () => {
    const battles = [];
    if (withRules(() => { endTurn(gameData, gameState, battles); notify(`Orders resolved. Year ${gameState.year} begins.`, "good"); })) await playBattleSequence(battles);
  });
  $("#skip-battle").addEventListener("click", () => { battleSkipCurrent = true; stopBattleAudio(); });
  $("#skip-all-battles").addEventListener("click", () => { battleSkipCurrent = battleSkipAll = true; stopBattleAudio(); });
  $(".battle-backdrop").addEventListener("click", () => { battleSkipCurrent = true; stopBattleAudio(); });
  $("#ending-menu").addEventListener("click", () => { $("#ending").hidden = true; showScreen("menu-screen"); });
  $("#zoom-in").addEventListener("click", () => { mapView.zoom = Math.min(4, mapView.zoom * 1.25); drawMap(); });
  $("#zoom-out").addEventListener("click", () => { mapView.zoom = Math.max(1, mapView.zoom / 1.25); if (mapView.zoom === 1) mapView.panX = mapView.panY = 0; drawMap(); });
  $("#reset-map").addEventListener("click", () => { mapView.zoom = 1; mapView.panX = mapView.panY = 0; drawMap(); });
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); mapView.zoom = clampMapZoom(mapView.zoom * (event.deltaY < 0 ? 1.12 : .9)); if (mapView.zoom === 1) mapView.panX = mapView.panY = 0; drawMap(); }, { passive: false });
  canvas.addEventListener("pointerdown", (event) => { canvas.setPointerCapture(event.pointerId); mapView.dragging = true; mapView.moved = 0; mapView.lastX = event.clientX; mapView.lastY = event.clientY; });
  canvas.addEventListener("pointermove", (event) => { if (!mapView.dragging) return; const dx = event.clientX - mapView.lastX; const dy = event.clientY - mapView.lastY; mapView.moved += Math.abs(dx) + Math.abs(dy); if (mapView.zoom > 1) { mapView.panX += dx; mapView.panY += dy; drawMap(); } mapView.lastX = event.clientX; mapView.lastY = event.clientY; });
  canvas.addEventListener("pointerup", (event) => {
    if (mapView.moved < 6) pickCountry(event);
    mapView.dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointercancel", () => { mapView.dragging = false; mapView.moved = 0; });
  canvas.addEventListener("lostpointercapture", () => { mapView.dragging = false; });
  canvas.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const countries = gameData.map.countries;
    const current = Math.max(0, countries.findIndex((country) => country.name === selectedCountry));
    const index = event.key === "Home" ? 0 : event.key === "End" ? countries.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + countries.length) % countries.length;
    selectedCountry = countries[index].name;
    renderAll();
  });
  new ResizeObserver(() => { resizeMap(); drawMap(); }).observe(canvas);
}

const clampMapZoom = (value) => Math.max(1, Math.min(4, value));

async function boot() {
  try {
    [gameData, localization] = await Promise.all([
      fetch("./data/game-data.json").then((response) => response.json()),
      fetch("./data/localization-en.json").then((response) => response.json()),
    ]);
    prepareMapGeometry();
    buildSetup();
    buildManual();
    bindEvents();
    savePreferences();
    updateResumeButton();
    $("#loading").remove();
    $("#app").hidden = false;
  } catch (error) {
    $("#loading").innerHTML = `<strong>Unable to load preservation data.</strong><p>${escapeHtml(error.message)}</p>`;
    console.error(error);
  }
}

boot();
