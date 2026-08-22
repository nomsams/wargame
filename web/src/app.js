import {
  GameRuleError,
  availableUnitCount,
  availableUpgrades,
  buyWorldUpgrade,
  canReach,
  cancelAction,
  checkVictory,
  displayCountry,
  endTurn,
  maxPurchasableUnits,
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
import { decodeHitColor, encodeHitColor, projectMapPoint } from "./projection.js";

const SAVE_KEY = "wargame-preservation-save-v1";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const asset = (name) => `./assets/${name}`;

let gameData;
let localization;
let gameState = null;
let selectedCountry = null;
let selectedFaction = null;
let toastTimer;

const canvas = $("#world-map");
const context = canvas.getContext("2d", { alpha: false });
const hitCanvas = document.createElement("canvas");
const hitContext = hitCanvas.getContext("2d", { willReadFrequently: true });
const mapView = { zoom: 1, panX: 0, panY: 0, dragging: false, moved: 0, lastX: 0, lastY: 0 };
const countryEdges = [];

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function localized(key, fallback = key) {
  return localization?.[key] || fallback;
}

function countryLabel(name) {
  return localized(name, displayCountry(name));
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
      const center = pointOnMap(capital.center, width, height);
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
  panel.style.setProperty("--owner", ownerMeta.color);
  panel.style.setProperty("--accent", ownerMeta.accent);
  panel.innerHTML = `
    <div class="country-head"><button id="close-country" class="country-close" aria-label="Close country panel">×</button><span class="country-owner">${escapeHtml(ownerMeta.short)}</span><h2 class="country-name">${escapeHtml(countryLabel(selectedCountry))}</h2><div class="country-resource"><img src="${asset(RESOURCE_IMAGES[source.countryResource])}" alt="">${escapeHtml(resource)} · $${source.cashPerTurn}/year</div></div>
    <div class="country-actions">
      ${own ? `<button id="move-action">Move / Attack</button><button id="buy-action">Buy Units</button><button id="country-upgrade-action">Upgrades</button><button id="country-info-action">Country Info</button>` : ""}
      ${hostile ? `<button id="spy-country-action">Spy</button><button id="attack-help-action" class="attack">How to attack</button>` : ""}
    </div>
    <section class="panel-section"><h3>Garrison</h3>${unitsMarkup(view)}</section>
    <section class="panel-section"><h3>Infrastructure</h3>${view.upgrades ? `<div class="upgrade-pills">${upgradePills}</div>` : `<div class="redacted">Infrastructure classified</div>`}</section>
    <section class="panel-section"><h3>Strategic data</h3><div class="upgrade-pills"><span>${escapeHtml(source.hasSeaBorder ? "Sea border" : "Landlocked")}</span><span>${source.adjoiningCountries.length} borders</span>${country.nukedUntil > gameState.year ? `<span>Uninhabitable until ${country.nukedUntil}</span>` : ""}</div></section>`;
  $("#move-action")?.addEventListener("click", () => openMoveDialog(selectedCountry));
  $("#close-country")?.addEventListener("click", () => { selectedCountry = null; renderAll(); });
  $("#buy-action")?.addEventListener("click", () => openBuyDialog(selectedCountry));
  $("#country-upgrade-action")?.addEventListener("click", () => openCountryUpgrades(selectedCountry));
  $("#country-info-action")?.addEventListener("click", () => openCountryInfo(selectedCountry));
  $("#spy-country-action")?.addEventListener("click", () => openSpyDialog(selectedCountry));
  $("#attack-help-action")?.addEventListener("click", () => notify("Select one of your countries, choose Move / Attack, then target this country."));
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
      target.innerHTML = gameData.countries.filter((country) => canReach(gameData, gameState, gameState.playerFaction, fromName, country.name, unitType)).map((country) => `<option value="${country.name}">${escapeHtml(countryLabel(country.name))}${gameState.countries[country.name].owner === gameState.playerFaction ? " — move" : " — attack"}</option>`).join("");
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
      if (withRules(() => queueMove(gameData, gameState, gameState.playerFaction, fromName, $("#move-target", root).value, $("#move-unit", root).value, $("#move-quantity", root).value))) closeDialog();
    });
  });
}

function upgradeCard(upgrade, mode, countryName = null) {
  const description = localized(`${upgrade.title} Description`, "Recovered strategic upgrade.");
  return `<article class="action-card"><img src="${asset(upgrade.image)}" alt=""><div><h3>${escapeHtml(upgrade.short || upgrade.title)} <span class="price">$${upgrade.cost.toLocaleString()}</span></h3><p>${escapeHtml(description)}</p><button type="button" data-upgrade="${upgrade.id}" data-mode="${mode}" ${gameState.factions[gameState.playerFaction].cash < upgrade.cost ? "disabled" : ""}>Build${countryName ? ` in ${escapeHtml(countryLabel(countryName))}` : ""}</button></div></article>`;
}

function openCountryUpgrades(countryName) {
  const upgrades = availableUpgrades(gameData, gameState, gameState.playerFaction, "country", countryName);
  openDialog(countryLabel(countryName), "Country Upgrades", upgrades.length ? `<div class="dialog-grid">${upgrades.map((upgrade) => upgradeCard(upgrade, "country", countryName)).join("")}</div>` : `<p>Every available upgrade has already been built here.</p>`, (root) => {
    $$('[data-mode="country"]', root).forEach((button) => button.addEventListener("click", () => { if (withRules(() => queueUpgrade(gameData, gameState, gameState.playerFaction, countryName, Number(button.dataset.upgrade)))) closeDialog(); }));
  });
}

function openWorldUpgrades() {
  const upgrades = availableUpgrades(gameData, gameState, gameState.playerFaction, "world");
  openDialog("Faction research", "World Upgrades", upgrades.length ? `<div class="dialog-grid">${upgrades.map((upgrade) => upgradeCard(upgrade, "world")).join("")}</div>` : `<p>All faction world upgrades have been completed.</p>`, (root) => {
    $$('[data-mode="world"]', root).forEach((button) => button.addEventListener("click", () => { if (withRules(() => buyWorldUpgrade(gameData, gameState, gameState.playerFaction, Number(button.dataset.upgrade)))) closeDialog(); }));
  });
}

function openCountryInfo(countryName) {
  const source = gameData.countries.find((country) => country.name === countryName);
  const state = gameState.countries[countryName];
  openDialog("Country intelligence", countryLabel(countryName), `<div class="dialog-grid"><article class="action-card"><img src="${asset(RESOURCE_IMAGES[source.countryResource])}" alt=""><div><h3>${RESOURCE_NAMES[source.countryResource]}</h3><p>${escapeHtml(localized(`${RESOURCE_NAMES[source.countryResource]} Description`, "Strategic national resource."))}</p><span class="price">Base income $${source.cashPerTurn}/year</span></div></article><article class="action-card"><img src="${asset("countryGarnisonImage.png")}" alt=""><div><h3>Operational borders</h3><p>${source.adjoiningCountries.map(countryLabel).join(" · ")}</p><span>${source.hasSeaBorder ? "Sea access available" : "Landlocked"}</span></div></article></div><div class="intel-panel">${state.nukedUntil > gameState.year ? `Nuclear fallout prevents occupation until ${state.nukedUntil}.` : "Country is operational."}</div>`);
}

function openSpyDialog(defaultTarget = null) {
  const targets = gameData.countries.filter((country) => {
    const owner = gameState.countries[country.name].owner;
    return owner && owner !== gameState.playerFaction;
  });
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
  if (action.type === "move") return `${action.quantity} ${UNIT_TYPES[action.unitType].label.toLowerCase()}: ${countryLabel(action.from)} → ${countryLabel(action.to)}`;
  if (action.type === "country-upgrade") return `Build ${upgradeById(action.upgradeId)?.title} in ${countryLabel(action.country)}`;
  return action.type;
}

function openQueue() {
  const actions = gameState.queue.filter((action) => action.faction === gameState.playerFaction);
  openDialog("Pending orders", "Action Queue", actions.length ? `<div class="queue-list">${actions.map((action) => `<div class="queue-item"><div><strong>${escapeHtml(actionDescription(action))}</strong><span>${action.cost ? ` · $${action.cost} reserved` : ""}</span></div><button type="button" data-cancel="${action.id}">Cancel</button></div>`).join("")}</div>` : `<p>No orders are queued. Spy actions are processed immediately.</p>`, (root) => {
    $$('[data-cancel]', root).forEach((button) => button.addEventListener("click", () => { if (withRules(() => cancelAction(gameState, button.dataset.cancel))) { closeDialog(); openQueue(); } }));
  });
}

function openObjective() {
  const faction = gameState.factions[gameState.playerFaction];
  const owned = Object.values(gameState.countries).filter((country) => country.owner === gameState.playerFaction).length;
  const log = gameState.log.slice(0, 18).map((item) => `<div class="log-item"><span>${item.year}</span><strong>${escapeHtml(item.message)}</strong></div>`).join("");
  openDialog(faction.general.name, OBJECTIVES[gameState.objective].title, `<p>${escapeHtml(OBJECTIVES[gameState.objective].description)}</p><div class="intel-panel">Rank ${faction.general.level} · ${faction.conquests} conquests · ${owned} countries · $${faction.cash.toLocaleString()}</div><h3>Campaign log</h3><div class="log-list">${log}</div>`);
}

function buildManual() {
  $("#manual-content").innerHTML = `
    <p>Wargame is a turn-based strategy game. Every order you plan is queued for the end of the year; espionage is immediate. Expand from your faction's three starting countries, build an economy, and meet your chosen objective.</p>
    <h3>1. Tactical map</h3><p>Colored countries belong to factions; dark countries are neutral. Select one of your countries to move forces, buy units, build infrastructure, or inspect it. Drag the map to pan and use the wheel or zoom controls.</p>
    <h3>2. Moving and attacking</h3><p>Troops cross adjoining land borders. Ships travel between coastal countries. Planes, missiles, and commandos can reach distant targets. Moving into friendly territory transfers units; moving into hostile or neutral territory queues an attack.</p>
    <h3>3. Economy and buying</h3><p>Every controlled country pays cash each year. Units may be bought in a faction's original countries or anywhere with a Supply Center. National resources reduce the cost of related units. Power Plants and faction infrastructure improve income.</p>
    <h3>4. Combat</h3><p>Each faction has the original unit attack, defence, and cost profile recovered from the app. Generals, country defences, bribery, and world upgrades modify combat. Attacks include the small uncertainty present in battlefield operations.</p>
    <h3>5. Upgrades and spying</h3><p>Country upgrades include AWFDS, Supply Centers, Power Plants, and a faction-specific ability. World upgrades unlock decisive faction powers. Intelligence reveals a hidden garrison; Bribery halves its defence for the current year; 00 Agents unlock hits against rival generals.</p>
    <h3>6. End turn and saves</h3><p>End Turn lets all computer factions plan, then resolves purchases, construction, moves, and battles. Income is collected and neutral armies grow. Campaigns autosave locally after every order and can also be saved from the toolbar.</p>`;
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
  $("#resume-button").addEventListener("click", () => { const saved = readSave(); if (saved) { gameState = saved; selectedCountry = gameData.factions.find((faction) => faction.factionName === gameState.playerFaction)?.capitalCountry; showScreen("game-screen"); } });
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
  $("#save-button").addEventListener("click", () => { autosave(); notify("Campaign saved in this browser.", "good"); });
  $("#end-turn-button").addEventListener("click", () => withRules(() => { endTurn(gameData, gameState); notify(`Orders resolved. Year ${gameState.year} begins.`, "good"); }));
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
    updateResumeButton();
    $("#loading").remove();
    $("#app").hidden = false;
  } catch (error) {
    $("#loading").innerHTML = `<strong>Unable to load preservation data.</strong><p>${escapeHtml(error.message)}</p>`;
    console.error(error);
  }
}

boot();
