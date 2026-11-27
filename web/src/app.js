import {
  GameRuleError,
  availableUnitCount,
  availableBoardingCapacity,
  availableUpgrades,
  canBuyIn,
  canReach,
  checkVictory,
  awardedMedals,
  availableUnitUpgrades,
  countryResourceBonus,
  displayCountry,
  endTurn,
  maxPurchasableUnits,
  migrateSavedGame,
  navalTransportMultiplier,
  newGame,
  publicCountryView,
  unitCost,
  validateSavedGame,
} from "./engine.js";
import { DIFFICULTIES, FACTION_META, MEDALS, OBJECTIVES, RESOURCE_IMAGES, RESOURCE_NAMES, SPY_ACTIONS, UNIT_TYPES, unitUpgradeBranch, unitUpgradeById, upgradeById } from "./config.js";
import { CAPITAL_MARKER_OVERRIDES, clampMapZoom, decodeHitColor, encodeHitColor, hitTestPixel, mapProjectionFrame, pinchMapView, projectMapPoint } from "./projection.js";
import { MAX_SAVE_FILE_BYTES, SaveTransferError, parseSaveText, saveFilename, serializeSave } from "./save-transfer.js";
import { runOrder } from "./match.js";
import { createMatchSave, guestSaveForHello, playMatch, readMatchSave } from "./match-session.js";
import { allianceBetween, forceInCountry, friendlyFaction, isSupplied } from "./diplomacy.js";
import { REGIONAL_SCENARIO, scenarioData } from "./scenario.js";
import { openLobby } from "./lobby.js";
import { parseSignalCode } from "./peer.js";

const SAVE_KEY = "wargame-preservation-save-v1";
const PREFERENCES_KEY = "wargame-preservation-preferences-v1";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const asset = (name) => `./assets/${name}`;

let gameData;
let boardData;
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
let multiplayer = null;
let replay = null;
let draftRoute = null;
const routeStyles = {
  troops: ["#ffcb55", []], ships: ["#58dcff", [8, 4]], planes: ["#f6f6ff", [3, 4]],
  missiles: ["#ff766e", [8, 3, 2, 3]], commandos: ["#d5a4ff", [2, 4]],
};

const canvas = $("#world-map");
const context = canvas.getContext("2d", { alpha: false });
const hitCanvas = document.createElement("canvas");
const hitContext = hitCanvas.getContext("2d", { willReadFrequently: true });
const mapView = { zoom: 1, panX: 0, panY: 0, dragging: false, moved: 0, lastX: 0, lastY: 0 };
const mapPointers = new Map();
let pinchGesture = null;
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

function initialCountrySelection(factionName) {
  if (window.matchMedia("(max-width: 850px)").matches) return null;
  return gameData.factions.find((faction) => faction.factionName === factionName)?.capitalCountry || null;
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
  window.scrollTo(0, 0);
  if (id === "menu-screen") updateResumeButton();
  if (id === "game-screen") requestAnimationFrame(() => {
    if (!gameState || !$("#game-screen").classList.contains("active")) return;
    resizeMap();
    renderAll();
    checkEnding();
  });
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

function submitOrder(type, args, onApplied = null) {
  return withRules(() => {
    const result = multiplayer ? multiplayer.order(type, args) : runOrder(gameData, gameState, type, args);
    if (multiplayer) gameState = multiplayer.state;
    onApplied?.(result);
  });
}

function openMultiplayer(invite = null, resumeOnly = false) {
  const savedHost = multiplayer?.seat === 1 ? null : readMatchSave(boardData, 0);
  let activeSession;
  openLobby({
    openDialog, invite, saved: savedHost, resumeOnly, regionalScenario: REGIONAL_SCENARIO,
    factionsForScenario: (scenario) => scenarioData(boardData, scenario).factions.map(({ factionName }) =>
      ({ id: escapeHtml(factionName), label: escapeHtml(FACTION_META[factionName].short) })),
    onMatch(peer, seat, input) {
      const { save, key } = seat === 0
        ? { save: input.savedMatch || createMatchSave(boardData, input), key: null }
        : guestSaveForHello(boardData, input, readMatchSave(boardData, 1));
      const session = playMatch(boardData, save, seat, peer, (resolved) => {
        if (multiplayer !== session) return;
        gameState = session.state;
        if (resolved) {
          closeReplay();
          closeDialog();
          notify(`Both orders resolved. Year ${gameState.year} begins.`, "good");
        }
        renderAll();
        checkEnding();
      });
      activeSession = multiplayer = session;
      gameData = session.data;
      gameState = session.state;
      selectedCountry = initialCountrySelection(gameState.playerFaction);
      Object.assign(mapView, { zoom: 1, panX: 0, panY: 0 });
      showScreen("game-screen");
      session.start(key);
    },
    async onMessage(command) {
      if (activeSession && multiplayer === activeSession) await activeSession.receive(command);
    },
    onDisconnect(reason) {
      if (multiplayer !== activeSession) return;
      notify(reason, "bad");
      renderStatus();
    },
  });
}

function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = migrateSavedGame(JSON.parse(raw));
    return validateSavedGame(parsed, scenarioData(boardData, parsed?.scenario)) ? parsed : null;
  } catch {
    return null;
  }
}

function autosave() {
  if (gameState && !multiplayer) localStorage.setItem(SAVE_KEY, JSON.stringify(gameState));
}

function campaignFile() {
  const exportedAt = new Date();
  return new File([serializeSave(gameState, exportedAt)], saveFilename(gameState, exportedAt), { type: "application/json" });
}

function downloadCampaign(file = campaignFile()) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`Downloaded ${file.name}.`, "good");
}

function canShareCampaignFile(file) {
  try {
    return typeof navigator.share === "function" && (typeof navigator.canShare !== "function" || navigator.canShare({ files: [file] }));
  } catch {
    return false;
  }
}

async function shareCampaign(file = campaignFile()) {
  if (!canShareCampaignFile(file)) {
    downloadCampaign(file);
    notify("Nearby sharing is unavailable here, so the save was downloaded instead.", "good");
    return;
  }
  try {
    await navigator.share({ title: "Wargame campaign", text: `Wargame campaign — year ${gameState.year}`, files: [file] });
    notify("Save handed to your device's share sheet.", "good");
  } catch (error) {
    if (error.name !== "AbortError") {
      downloadCampaign(file);
      notify("Sharing failed, so the save was downloaded instead.", "bad");
    }
  }
}

function openSaveManager() {
  if (multiplayer) {
    const connected = multiplayer.connected;
    openDialog("Multiplayer", "Match Save", `<p>Your latest rounds and private draft are saved in this browser.</p><p class="section-help">If the connection drops, the host creates a fresh invite from their saved match. The guest opens it in the browser that played the match.</p>${!connected ? '<button id="reconnect-match" class="primary-button" type="button">Reconnect</button>' : ""}`, (root) => {
      $("#reconnect-match", root)?.addEventListener("click", () => openMultiplayer(null, true));
    });
    return;
  }
  autosave();
  sessionSaveBaseline = localStorage.getItem(SAVE_KEY);
  const file = campaignFile();
  const shareAvailable = canShareCampaignFile(file);
  openDialog("Campaign portability", "Save & Transfer", `<p class="section-help">Keep a portable copy, import it on another browser, or send it directly with your device's share sheet. AirDrop, Quick Share, and Nearby Share transfer device-to-device when your platform offers them.</p><div class="save-transfer-grid"><button id="save-local" class="save-transfer-card" type="button"><strong>Save in browser</strong><span>Update this device's local campaign.</span></button><button id="download-save" class="save-transfer-card" type="button"><strong>Download save file</strong><span>Store a portable, human-readable JSON copy.</span></button><button id="share-save" class="save-transfer-card" type="button"><strong>Share to phone</strong><span>${shareAvailable ? "Open the system share sheet for nearby transfer." : "Download a file to send with your preferred nearby-transfer app."}</span></button><button id="upload-save" class="save-transfer-card" type="button"><strong>Upload save file</strong><span>Continue a campaign received from another device.</span></button></div><p class="save-safety">Imports are limited to 2 MB and must pass the complete game-state validator. Save files contain data only—no scripts or executable code.</p>`, (root) => {
    $("#save-local", root).addEventListener("click", () => notify("Campaign saved in this browser.", "good"));
    $("#download-save", root).addEventListener("click", () => downloadCampaign(file));
    $("#share-save", root).addEventListener("click", () => shareCampaign(file));
    $("#upload-save", root).addEventListener("click", () => $("#save-file-input").click());
  });
}

function openImportReview(importedGame, sourceName) {
  const faction = FACTION_META[importedGame.playerFaction]?.short || importedGame.playerFaction;
  const owned = Object.values(importedGame.countries).filter((country) => country.owner === importedGame.playerFaction).length;
  openDialog("Validated save file", "Load Campaign?", `<p><strong>${escapeHtml(faction)}</strong> · Year ${importedGame.year} · ${owned} countries</p><p class="section-help">Source: ${escapeHtml(sourceName)}. Loading it replaces this browser's local save. Download the current campaign first if you want a separate backup.</p><div class="dialog-actions import-actions"><button id="confirm-import" class="primary-button" type="button">Load imported campaign</button><button id="cancel-import" class="secondary-button" type="button">Cancel</button></div>`, (root) => {
    $("#confirm-import", root).addEventListener("click", () => {
      gameState = importedGame;
      gameData = scenarioData(boardData, gameState.scenario);
      selectedCountry = initialCountrySelection(gameState.playerFaction);
      localStorage.setItem(SAVE_KEY, JSON.stringify(gameState));
      sessionSaveBaseline = localStorage.getItem(SAVE_KEY);
      closeDialog();
      showScreen("game-screen");
      notify(`Loaded ${sourceName}.`, "good");
    });
    $("#cancel-import", root).addEventListener("click", closeDialog);
  });
}

async function importCampaignFile(file) {
  if (!file) return;
  try {
    if (file.size > MAX_SAVE_FILE_BYTES) throw new SaveTransferError("That save is larger than the 2 MB safety limit.");
    const importedGame = parseSaveText(await file.text(), boardData);
    openImportReview(importedGame, file.name);
  } catch (error) {
    notify(error instanceof SaveTransferError ? error.message : "The save file could not be loaded.", "bad");
  } finally {
    $("#save-file-input").value = "";
  }
}

function updateResumeButton() {
  $("#resume-button").disabled = !readSave();
}

function factionMark(meta) {
  return meta.flag ? `<img src="${asset(meta.flag)}" alt="">` : `<span class="faction-monogram" style="--faction-accent:${meta.accent}">${meta.code}</span>`;
}

function buildFactionOptions() {
  const grid = $("#faction-grid");
  const data = scenarioData(boardData, $("#campaign-scenario").value);
  if (!data.factions.some(({ factionName }) => factionName === selectedFaction)) selectedFaction = data.factions[0].factionName;
  grid.innerHTML = "";
  for (const faction of data.factions) {
    const meta = FACTION_META[faction.factionName];
    const starting = data.countries.filter((country) => country.faction === faction.factionName).map((country) => countryLabel(country.name)).join(" · ");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "faction-option";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(faction.factionName === selectedFaction));
    button.style.setProperty("--faction", meta.color);
    button.style.setProperty("--accent", meta.accent);
    button.innerHTML = `${factionMark(meta)}<span><strong>${escapeHtml(meta.short)}</strong><small>${escapeHtml(starting)}</small></span>`;
    button.addEventListener("click", () => {
      selectedFaction = faction.factionName;
      $$(".faction-option", grid).forEach((item) => item.setAttribute("aria-checked", String(item === button)));
    });
    grid.append(button);
  }
}

function buildSetup() {
  buildFactionOptions();
  const objectives = $("#objective-select");
  objectives.innerHTML = Object.entries(OBJECTIVES).map(([id, item]) => `<option value="${id}">${escapeHtml(item.title)}</option>`).join("");
  // The original named each difficulty level after an army rank.
  $("#difficulty-select").innerHTML = DIFFICULTIES.map((item) =>
    `<option value="${item.id}" ${item.id === "normal" ? "selected" : ""}>${escapeHtml(item.title)} · ${escapeHtml(item.rank)}</option>`).join("");
}

function startCampaign() {
  sessionSaveBaseline = localStorage.getItem(SAVE_KEY);
  const scenario = $("#campaign-scenario").value;
  gameData = scenarioData(boardData, scenario);
  gameState = newGame(gameData, {
    playerFaction: selectedFaction,
    heroName: $("#hero-name").value.trim() || "General",
    objective: $("#objective-select").value,
    difficulty: $("#difficulty-select").value,
    scenario,
    alliances: $("#campaign-alliances").checked,
  });
  selectedCountry = initialCountrySelection(selectedFaction);
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
  const event = replay?.events[replay.index];
  if (event?.country === name && event.type === "battle") return event.winner ? FACTION_META[event.winner].color : "#161d27";
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
  const frame = mapProjectionFrame(width, height);
  canvas.dataset.zoom = mapView.zoom.toFixed(3);
  canvas.dataset.projectionAspect = (frame.width / frame.height).toFixed(3);
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

  drawRoutes(width, height);
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

function drawRoutes(width, height) {
  if (!gameState) return;
  const current = gameState.playerFaction;
  const event = replay?.events[replay.index];
  const routes = event ? [{ from: event.from, to: event.country, unitType: event.unitType }]
    : gameState.queue.filter((order) => order.type === "move" && order.faction === current);
  if (draftRoute && !event) routes.push(draftRoute);
  const incoming = routes.some(({ to }) => to === selectedCountry);
  context.save();
  for (const route of routes) {
    const origin = gameData.map.countries.find(({ name }) => name === route.from);
    const destination = gameData.map.countries.find(({ name }) => name === route.to);
    const style = routeStyles[route.unitType];
    if (!origin || !destination || !style) continue;
    const [x, y] = pointOnMap(origin.center, width, height);
    const [endX, endY] = pointOnMap(destination.center, width, height);
    const length = Math.hypot(endX - x, endY - y);
    if (!length) continue;
    const scale = mapView.zoom;
    const dx = (endX - x) / length, dy = (endY - y) / length;
    const bend = Math.min(28, length * .15);
    const midX = (x + endX) / 2 - dy * bend, midY = (y + endY) / 2 + dx * bend;
    context.globalAlpha = event || route === draftRoute || route.to === selectedCountry ? .93 : incoming ? .2 : .65;
    context.strokeStyle = context.fillStyle = style[0];
    context.lineWidth = (route.to === selectedCountry ? 2.7 : 1.8) / scale;
    context.setLineDash(style[1].map((step) => step / scale));
    context.beginPath();
    context.moveTo(x, y);
    context.quadraticCurveTo(midX, midY, endX, endY);
    context.stroke();
    const angle = Math.atan2(endY - midY, endX - midX);
    const arrow = Math.min(9 / scale, length * .55);
    context.beginPath();
    context.moveTo(endX, endY);
    context.lineTo(endX - Math.cos(angle - .5) * arrow, endY - Math.sin(angle - .5) * arrow);
    context.lineTo(endX - Math.cos(angle + .5) * arrow, endY - Math.sin(angle + .5) * arrow);
    context.fill();
  }
  context.restore();
}

function previewRoute(from, to, unitType) {
  draftRoute = from && to && unitType ? { from, to, unitType } : null;
  drawMap();
}

function pickCountry(event) {
  const rect = canvas.getBoundingClientRect();
  // hitTestPixel scales by the real backing-store size rather than recomputing
  // the device ratio, so the rounding in resizeMap cannot drift from the pick,
  // and it clamps: a click on or just past the right or bottom edge would
  // otherwise index outside the canvas and make getImageData throw.
  const x = hitTestPixel(event.clientX - rect.left, rect.width, hitCanvas.width);
  const y = hitTestPixel(event.clientY - rect.top, rect.height, hitCanvas.height);
  if (x < 0 || y < 0) return;
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
  const friendly = friendlyFaction(gameState, gameState.playerFaction, country.owner);
  const localForce = forceInCountry(country, gameState.playerFaction);
  const hostile = country.owner && !friendly;
  const attackable = !friendly && country.nukedUntil <= gameState.year;
  const canPurchaseHere = own && canBuyIn(gameData, gameState, gameState.playerFaction, selectedCountry);
  const boardableShips = localForce ? gameState.queue.filter((action) => action.type === "move" && action.unitType === "ships"
    && action.faction === gameState.playerFaction && action.from === selectedCountry && availableBoardingCapacity(gameState, gameState.playerFaction, action.id) > 0) : [];
  const incoming = gameState.queue.filter((order) => order.type === "move" && order.faction === gameState.playerFaction && order.to === selectedCountry);
  panel.style.setProperty("--owner", ownerMeta.color);
  panel.style.setProperty("--accent", ownerMeta.accent);
  panel.innerHTML = `
    <div class="country-head"><button id="close-country" class="country-close" aria-label="Close country panel">×</button><span class="country-owner">${escapeHtml(ownerMeta.short)}</span><h2 class="country-name">${escapeHtml(countryLabel(selectedCountry))}</h2><div class="country-resource"><img src="${asset(RESOURCE_IMAGES[source.countryResource])}" alt=""><span>${escapeHtml(resource)} · $${source.cashPerTurn}/year<small>Yearly resource bonus: ${escapeHtml(resourceBonusText(selectedCountry, Boolean(view.upgrades)))}</small></span></div></div>
    <div class="country-actions">
      ${own ? `<button id="move-action">Move / Attack</button><button id="buy-action" ${canPurchaseHere ? "" : "disabled title=\"Build a Supply Center to buy units here\""}>Buy Units</button><button id="country-upgrade-action">Upgrades</button><button id="country-info-action">Country Info</button>` : ""}
      ${boardableShips.length ? `<button id="board-action" class="transport-action">Board Troops <span>${boardableShips.length}</span></button>` : ""}
      ${hostile ? `<button id="spy-country-action">Spy</button>` : ""}${attackable ? `<button id="attack-country-action" class="attack">Attack Country</button>` : ""}
      ${!own && localForce ? '<button id="move-action">Move visiting forces</button>' : ""}
      ${gameState.diplomacy?.alliances.some(({ members }) => members.includes(gameState.playerFaction)) ? '<button id="support-action">Ask for support</button>' : ""}
    </div>
    ${incoming.length ? `<section class="panel-section"><h3>Incoming orders</h3><ul class="incoming-orders">${incoming.map((order) =>
      `<li style="--route-color:${routeStyles[order.unitType][0]}">${order.quantity} ${UNIT_TYPES[order.unitType].label.toLowerCase()} from ${escapeHtml(countryLabel(order.from))}${order.carriedTroops ? ` (+${order.carriedTroops} troops aboard)` : ""}</li>`).join("")}</ul></section>` : ""}
    <section class="panel-section"><h3>Garrison</h3>${unitsMarkup(view)}</section>
    ${friendly && Object.entries(country.visitors || {}).some(([, units]) => Object.values(units).some(Boolean))
      ? `<section class="panel-section"><h3>Allied visitors</h3>${Object.entries(country.visitors).filter(([, units]) => Object.values(units).some(Boolean)).map(([name, units]) => `<p>${escapeHtml(FACTION_META[name].short)}</p>${unitsMarkup({ units })}`).join("")}</section>` : ""}
    ${own && gameState.diplomacy ? `<section class="panel-section"><h3>Supply line</h3><p>${isSupplied(gameData, gameState, gameState.playerFaction, selectedCountry) ? "Connected to an allied headquarters." : "Isolated or blockaded · unit prices +20%"}</p></section>` : ""}
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
  $("#support-action")?.addEventListener("click", () => openDiplomacy(selectedCountry));
}

function renderStatus() {
  if (!gameState) return;
  const factionName = gameState.playerFaction;
  const meta = FACTION_META[factionName];
  $("#status-flag").hidden = !meta.flag;
  if (meta.flag) $("#status-flag").src = asset(meta.flag);
  $("#status-monogram").hidden = Boolean(meta.flag);
  $("#status-monogram").textContent = meta.code;
  $("#status-faction").textContent = meta.short;
  $("#status-general").textContent = `${gameState.factions[factionName].general.name} · Rank ${gameState.factions[factionName].general.level}`;
  $("#status-year").textContent = gameState.year;
  $("#status-countries").textContent = Object.values(gameState.countries).filter((country) => country.owner === factionName).length;
  $("#status-cash").textContent = `$${gameState.factions[factionName].cash.toLocaleString()}`;
  $("#queue-count").textContent = gameState.queue.filter((action) => action.faction === factionName).length;
  const turnButton = $("#end-turn-button");
  const turnLabel = $("span", turnButton);
  const turnDetail = $("small", turnButton);
  if (multiplayer) {
    const connected = multiplayer.connected;
    turnButton.disabled = !connected || multiplayer.locked || multiplayer.finished;
    turnLabel.textContent = !connected ? "Disconnected" : multiplayer.locked ? "Orders Locked" : "Lock Orders";
    turnDetail.textContent = connected ? "Reveal when both lock" : "Use Save to reconnect";
  } else {
    turnButton.disabled = false;
    turnLabel.textContent = "End Turn";
    turnDetail.textContent = "Resolve orders";
  }
  $("#diplomacy-button").hidden = !gameState.diplomacy;
  $("#replay-button").hidden = !gameState.lastReplay?.events.length;
}

function renderAll() {
  if (!gameState) return;
  renderStatus();
  renderCountryPanel();
  drawMap();
}

function openDialog(kicker, title, content, ready) {
  if (draftRoute) previewRoute(null);
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
  if (draftRoute) previewRoute(null);
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
      if (submitOrder("buy", [countryName, $("#buy-unit", root).value, $("#buy-quantity", root).value])) closeDialog();
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
        const controlled = friendlyFaction(gameState, gameState.playerFaction, gameState.countries[country.name].owner);
        return `<option value="${country.name}" class="${controlled ? "controlled-option" : "uncontrolled-option"}">${escapeHtml(countryLabel(country.name))}${controlled ? " — move" : " — attack"}</option>`;
      }).join("");
      const available = availableUnitCount(gameState, gameState.playerFaction, fromName, unitType);
      const quantity = $("#move-quantity", root);
      quantity.max = available;
      if (Number(quantity.value) > available) quantity.value = available;
      target.disabled = !target.options.length;
      $("#move-submit", root).disabled = !target.options.length;
      $("#move-help", root).textContent = target.options.length ? `${available} uncommitted ${UNIT_TYPES[unitType].label.toLowerCase()} can be ordered.` : "No valid target is in range for this unit.";
      previewRoute(fromName, target.value, unitType);
    };
    $("#move-unit", root).addEventListener("change", updateTargets); updateTargets();
    $("#move-target", root).addEventListener("change", (event) => previewRoute(fromName, event.target.value, $("#move-unit", root).value));
    $("#move-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      let queuedAction;
      const unitType = $("#move-unit", root).value;
      if (submitOrder("move", [fromName, $("#move-target", root).value, unitType, $("#move-quantity", root).value], (order) => { queuedAction = order; })) {
        if (unitType === "ships" && availableBoardingCapacity(gameState, gameState.playerFaction, queuedAction.id) > 0) openBoardTroopsDialog([queuedAction]);
        else closeDialog();
      }
    });
  });
}

function attackSourcesFor(targetName) {
  return countriesAlphabetically(gameData.countries.filter((country) => forceInCountry(gameState.countries[country.name], gameState.playerFaction)
    && Object.keys(UNIT_TYPES).some((unitType) => availableUnitCount(gameState, gameState.playerFaction, country.name, unitType) > 0
      && canReach(gameData, gameState, gameState.playerFaction, country.name, targetName, unitType))));
}

function openAttackTargetDialog(targetName) {
  const target = gameState.countries[targetName];
  if (!target || friendlyFaction(gameState, gameState.playerFaction, target.owner)) return notify("Select a hostile or neutral country to plan an attack.", "bad");
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
        previewRoute(sourceSelect.value, targetName, unitSelect.value);
      };
      sourceSelect.addEventListener("change", updateUnits);
      unitSelect.addEventListener("change", updateQuantity);
      $("#attack-form", root).addEventListener("submit", (event) => {
        event.preventDefault();
        const sourceName = sourceSelect.value;
        const unitType = unitSelect.value;
        let queuedAction;
        if (submitOrder("move", [sourceName, targetName, unitType, quantity.value], (order) => { queuedAction = order; })) {
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
      if (submitOrder("board", [$("#board-route", root).value, $("#board-quantity", root).value])) {
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
        if (submitOrder("build", [countryName, Number(button.dataset.upgrade)])) render();
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
      const worldMarkup = upgrades.length ? `<div class="dialog-grid">${upgrades.map((upgrade) => upgradeCard(upgrade, "world", null, faction.worldUpgrades.includes(upgrade.id) ? "built" : "available")).join("")}</div>` : `<p>All faction world upgrades have been completed.</p>`;
      const installed = new Set(faction.unitUpgrades || []);
      const open = availableUnitUpgrades(gameState, gameState.playerFaction);
      const unitCard = (upgrade, status) => {
        const complete = status === "installed";
        const label = complete ? "Installed ✓" : status === "locked" ? "Alternative locked" : `Research $${upgrade.cost.toLocaleString()}`;
        return `<article class="action-card ${complete ? "action-complete" : ""}"><img src="${asset(upgrade.image)}" alt=""><div><h3>${escapeHtml(upgrade.title)} ${complete ? "" : `<span class="price">$${upgrade.cost.toLocaleString()}</span>`}</h3><p>${escapeHtml(localized(`${upgrade.title} Description`, "Permanent unit specialization."))}</p><button type="button" data-unit-upgrade="${upgrade.id}" ${status !== "open" || faction.cash < upgrade.cost ? "disabled" : ""}>${label}</button></div></article>`;
      };
      const sections = Object.keys(UNIT_TYPES).map((unitType) => {
        const owned = (faction.unitUpgrades || []).map((id) => unitUpgradeById(id)).find((upgrade) => upgrade?.unitType === unitType);
        const cards = unitUpgradeBranch(unitType).map((upgrade) => unitCard(upgrade, installed.has(upgrade.id) ? "installed" : owned ? "locked" : "open")).join("");
        return `<h3 class="dialog-section-title">${escapeHtml(UNIT_TYPES[unitType].label)} specialization</h3><div class="dialog-grid">${cards}</div>`;
      }).join("");
      const availableNote = open.length ? "" : `<p class="section-help">Every unit branch has been researched.</p>`;
      $("#world-upgrade-list", root).innerHTML = `<h3 class="dialog-section-title">World research</h3>${worldMarkup}<h3 class="dialog-section-title">Unit research</h3><p class="section-help">Choose one permanent specialization per unit type. ${escapeHtml(availableNote)}</p>${sections}`;
      $$('[data-mode="world"]', root).forEach((button) => button.addEventListener("click", () => {
        if (submitOrder("research", [Number(button.dataset.upgrade)])) render();
      }));
      $$('[data-unit-upgrade]', root).forEach((button) => button.addEventListener("click", () => {
        if (submitOrder("specialize", [button.dataset.unitUpgrade])) render();
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
    return owner && !friendlyFaction(gameState, gameState.playerFaction, owner);
  }));
  if (!targets.length) return notify("No enemy countries remain.");
  const options = targets.map((country) => `<option value="${country.name}" ${country.name === defaultTarget ? "selected" : ""}>${escapeHtml(countryLabel(country.name))}</option>`).join("");
  const faction = gameState.factions[gameState.playerFaction];
  const strategic = `${faction.nukes > 0 ? `<article class="action-card"><img src="${asset("ManhattanProjectImage.png")}" alt=""><div><h3>Nuclear strike (${faction.nukes})</h3><p>Erase the target garrison, infrastructure, and control.</p><button type="button" data-weapon="nuke">Launch</button></div></article>` : ""}${faction.worldUpgrades.includes(17) ? `<article class="action-card"><img src="${asset("RailGunImage.png")}" alt=""><div><h3>Rail Gun</h3><p>Destroy roughly 85% of every defending unit. Ready ${faction.railGunReady <= gameState.year ? "now" : `in ${faction.railGunReady}`}.</p><button type="button" data-weapon="railgun" ${faction.railGunReady > gameState.year ? "disabled" : ""}>Fire</button></div></article>` : ""}`;
  const cards = Object.entries(SPY_ACTIONS).map(([id, action]) => `<article class="action-card"><img src="${asset(id === "intelligence" ? "IntelligenceImage.png" : id === "bribery" ? "BriberyImage.png" : "HitImage.png")}" alt=""><div><h3>${action.title} <span class="price">$${action.cost}</span></h3><p>${escapeHtml(localized(`Spy Action ${action.title} Description`, action.description))}</p><button type="button" data-spy="${id}" ${action.upgrade && !faction.worldUpgrades.includes(action.upgrade) ? "disabled" : ""}>Use</button></div></article>`).join("");
  openDialog("Immediate operations", "Spying & Strategic Weapons", `<label>Target<select id="spy-target">${options}</select></label><div class="dialog-grid" style="margin-top:14px">${cards}${strategic}</div>`, (root) => {
    $$('[data-spy]', root).forEach((button) => button.addEventListener("click", () => { if (submitOrder("spy", [button.dataset.spy, $("#spy-target", root).value])) closeDialog(); }));
    $$('[data-weapon]', root).forEach((button) => button.addEventListener("click", () => { if (submitOrder("strike", [button.dataset.weapon, $("#spy-target", root).value])) closeDialog(); }));
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
    $$('[data-cancel]', root).forEach((button) => button.addEventListener("click", () => { if (submitOrder("cancel", [button.dataset.cancel])) openQueue(); }));
    $$('[data-board]', root).forEach((button) => button.addEventListener("click", () => {
      const action = gameState.queue.find((item) => item.id === button.dataset.board);
      if (action) openBoardTroopsDialog([action]);
    }));
  });
}

function medalSummary(state) {
  const won = awardedMedals(state).length;
  return `${won} of ${MEDALS.length} recovered medals awarded. Difficulty: ${DIFFICULTIES.find((item) => item.id === state.difficulty)?.rank || state.difficulty}.`;
}
function openObjective() {
  const faction = gameState.factions[gameState.playerFaction];
  const controlledCountries = countriesAlphabetically(gameData.countries.filter((country) => gameState.countries[country.name].owner === gameState.playerFaction));
  const owned = controlledCountries.length;
  const forceCards = controlledCountries.map((country) => {
    const units = gameState.countries[country.name].units;
    return `<article class="force-country"><button type="button" data-force-country="${country.name}">${escapeHtml(countryLabel(country.name))}</button><div>${Object.entries(UNIT_TYPES).map(([unitType, meta]) => `<span title="${meta.label}"><img src="${asset(meta.icon)}" alt=""><b>${units[unitType].toLocaleString()}</b><small>${meta.label}</small></span>`).join("")}</div></article>`;
  }).join("");
  const medalCards = () => {
    const won = new Set(awardedMedals(gameState).map((medal) => medal.id));
    return MEDALS.map((medal) => {
      const earned = won.has(medal.id);
      const name = escapeHtml(localized(medal.name, medal.name));
      const description = escapeHtml(localized(`${medal.name} Description`, medal.description));
      return `<article class="medal-card ${earned ? "medal-earned" : ""}"><span class="medal-ribbon"><img src="${asset(earned ? medal.image : "medalDisabled.png")}" alt=""></span><div><h3>${name}</h3><p>${description}</p><span class="medal-status">${earned ? "Awarded ✓" : "Not yet awarded"}</span></div></article>`;
    }).join("");
  };  const log = gameState.log.slice(0, 18).map((item) => `<div class="log-item"><span>${item.year}</span><strong>${escapeHtml(item.message)}</strong></div>`).join("");
  openDialog(faction.general.name, OBJECTIVES[gameState.objective].title, `<p>${escapeHtml(OBJECTIVES[gameState.objective].description)}</p><div class="intel-panel">Rank ${faction.general.level} · ${faction.conquests} conquests · ${owned} countries · $${faction.cash.toLocaleString()}</div><h3 class="dialog-section-title">Controlled-country forces</h3><p class="section-help">Every garrison under your command, sorted A–Z. Select a country name to find it on the map.</p><div class="force-overview">${forceCards}</div><h3 class="dialog-section-title">Medals</h3><p class="section-help">${escapeHtml(medalSummary(gameState))}</p><div class="medal-grid">${medalCards()}</div><h3 class="dialog-section-title">Campaign log</h3><div class="log-list">${log}</div>`, (root) => {
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

function openDiplomacy(defaultTarget = null) {
  const actor = gameState.playerFaction;
  const diplomacy = gameState.diplomacy;
  if (!diplomacy) return;
  const factions = gameData.factions.filter(({ factionName }) => factionName !== actor && !gameState.factions[factionName].defeated);
  const label = (name) => escapeHtml(FACTION_META[name].short);
  const allies = factions.filter(({ factionName }) => allianceBetween(gameState, actor, factionName));
  const cards = factions.map(({ factionName: name }) => {
    const pact = allianceBetween(gameState, actor, name);
    const incoming = diplomacy.offers.some(({ from, to }) => from === name && to === actor);
    const outgoing = diplomacy.offers.some(({ from, to }) => from === actor && to === name);
    const button = (action, text) => `<button class="secondary-button" type="button" data-treaty="${action}" data-partner="${escapeHtml(name)}">${text}</button>`;
    return `<section class="treaty-card"><strong>${label(name)}</strong><div>${pact
      ? pact.locked ? "Co-op partner" : `Allied ${button("end", "End alliance")}`
      : incoming ? `${button("accept", "Accept")} ${button("decline", "Decline")}`
      : outgoing ? "Offer pending" : button("propose", "Offer alliance")}</div></section>`;
  }).join("");
  const requests = diplomacy.requests.filter(({ to }) => to === actor);
  const requestSummary = requests.map(({ from, target }) => `<p>${label(from)} asked for support in ${escapeHtml(countryLabel(target))}.</p>`).join("");
  const pending = diplomacy.requests.filter(({ from }) => from === actor)
    .map(({ to, target }) => `<p>Request sent to ${label(to)} for ${escapeHtml(countryLabel(target))}.</p>`).join("");
  const support = allies.length ? `<h3>Request military support</h3><form id="support-form" class="dialog-form">
    <label>Ally<select name="partner">${allies.map(({ factionName }) => `<option value="${escapeHtml(factionName)}">${label(factionName)}</option>`).join("")}</select></label>
    <label>Country<select name="target">${countriesAlphabetically().map(({ name }) => `<option value="${name}" ${name === defaultTarget ? "selected" : ""}>${escapeHtml(countryLabel(name))}</option>`).join("")}</select></label>
    <button class="primary-button" type="submit">Request support</button></form>` : "";
  openDialog("Alliances & logistics", "Diplomacy", `<p class="section-help">Allies can station forces in each other’s countries and combine attacks. The faction with the most surviving troops takes control after a joint capture.</p>${requestSummary}${pending}${cards}${support}`, (root) => {
    $$("[data-treaty]", root).forEach((button) => button.addEventListener("click", () => {
      if (submitOrder("treaty", [button.dataset.treaty, button.dataset.partner])) openDiplomacy(defaultTarget);
    }));
    $("#support-form", root)?.addEventListener("submit", (event) => {
      event.preventDefault();
      const { partner, target } = event.currentTarget.elements;
      if (submitOrder("support", [partner.value, target.value])) openDiplomacy(target.value);
    });
  });
}

function showReplayStep() {
  if (!replay) return;
  const event = replay.events[replay.index];
  const faction = FACTION_META[event.attacker || event.faction]?.short;
  const route = `${countryLabel(event.from)} → ${countryLabel(event.country)}`;
  const result = event.type === "transfer" ? "Reinforcements arrived"
    : event.won ? `${FACTION_META[event.winner]?.short || "Coalition"} captured the country` : "The defenders held";
  $("#replay-caption").textContent = `${replay.year} · ${replay.index + 1}/${replay.events.length} · ${faction} · ${event.quantity} ${UNIT_TYPES[event.unitType].label.toLowerCase()} · ${route} · ${result}`;
  $("#replay-prev").disabled = replay.index === 0;
  $("#replay-next").disabled = replay.index === replay.events.length - 1;
  drawMap();
}

function openReplay() {
  if (replay || !gameState.lastReplay?.events.length) return;
  replay = { ...gameState.lastReplay, index: 0, timer: null, map: { zoom: mapView.zoom, panX: mapView.panX, panY: mapView.panY } };
  Object.assign(mapView, { zoom: 1, panX: 0, panY: 0 });
  $("#turn-replay").hidden = false;
  showReplayStep();
}

function closeReplay() {
  if (!replay) return;
  clearInterval(replay.timer);
  Object.assign(mapView, replay.map);
  replay = null;
  $("#turn-replay").hidden = true;
  $("#replay-play").textContent = "Play";
  drawMap();
}

function stepReplay(amount) {
  if (!replay) return;
  replay.index = Math.max(0, Math.min(replay.events.length - 1, replay.index + amount));
  showReplayStep();
}

function toggleReplay() {
  if (!replay) return;
  if (replay.timer) {
    clearInterval(replay.timer);
    replay.timer = null;
    $("#replay-play").textContent = "Play";
    return;
  }
  if (replay.index === replay.events.length - 1) {
    replay.index = 0;
    showReplayStep();
  }
  $("#replay-play").textContent = "Pause";
  replay.timer = setInterval(() => {
    if (!replay || replay.index === replay.events.length - 1) toggleReplay();
    else stepReplay(1);
  }, 1100);
}

function exitToMenu(saveCurrent) {
  closeReplay();
  if (multiplayer) {
    const { peer } = multiplayer;
    multiplayer = null;
    peer.close();
  } else if (saveCurrent) {
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
  if (multiplayer) {
    openDialog("Multiplayer", "Leave Match?", '<p>The match is saved in this browser. Reconnect later with a fresh invite from the host.</p><div class="dialog-actions"><button id="leave-match" class="primary-button" type="button">Leave match</button><button id="stay-game" class="secondary-button" type="button">Stay in match</button></div>', (root) => {
      $("#leave-match", root).addEventListener("click", () => exitToMenu(false));
      $("#stay-game", root).addEventListener("click", closeDialog);
    });
    return;
  }
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
    for (const faction of [event.defender, event.attacker, ...(event.defendingAllies || [])]) {
      const key = faction || "__neutral__";
      if (!group.participants.some((item) => item.key === key)) group.participants.push({ key, faction });
    }
  }
  return [...groups.values()].filter((group) => group.events.some((event) =>
    event.attacker === gameState.playerFaction || event.defender === gameState.playerFaction || event.defendingAllies?.includes(gameState.playerFaction)));
}

function battleParticipantMarkup(participant) {
  const meta = participant.faction ? FACTION_META[participant.faction] : { short: "Neutral", flag: "neutralFlag.png", color: "#67717b" };
  return `<article class="battle-faction" data-faction="${escapeHtml(participant.key)}" style="--faction-color:${meta.color}">${factionMark(meta)}<strong>${escapeHtml(meta.short)}</strong><span class="battle-position">In position</span></article>`;
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

function openCountryFinder() {
  const options = countriesAlphabetically().map(({ name }) => `<option value="${escapeHtml(name)}">${escapeHtml(countryLabel(name))}</option>`).join("");
  openDialog("World map", "Find a Country", `<form id="find-country-form" class="dialog-form"><label>Country<select id="country-locator">${options}</select></label><button class="primary-button" type="submit">Show on map</button></form>`, (root) => {
    const select = $("#country-locator", root);
    if (selectedCountry) select.value = selectedCountry;
    $("#find-country-form", root).addEventListener("submit", (event) => {
      event.preventDefault();
      const country = gameData.map.countries.find(({ name }) => name === select.value);
      if (!country) return;
      const { width, height } = logicalSize();
      const vertices = gameData.map.vertices.slice(country.vertexStart, country.vertexStart + country.vertexLength);
      const points = vertices.map((vertex) => pointOnMap(vertex, width, height));
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const left = Math.min(...xs), right = Math.max(...xs);
      const top = Math.min(...ys), bottom = Math.max(...ys);
      const zoom = clampMapZoom(Math.min(width * .55 / Math.max(right - left, 1), height * .55 / Math.max(bottom - top, 1)));
      Object.assign(mapView, {
        zoom,
        panX: (width - left - right) / 2 * zoom,
        panY: (height - top - bottom) / 2 * zoom,
      });
      selectedCountry = window.matchMedia("(max-width: 850px)").matches ? null : country.name;
      closeDialog();
      renderAll();
      notify(countryLabel(country.name));
    });
  });
}

function battleResultText(group, finalOwner) {
  const player = gameState.playerFaction;
  const playerAttacked = group.events.some((event) => event.attacker === player);
  const playerDefended = group.events.some((event) => event.defender === player || event.defendingAllies?.includes(player));
  const allyHeld = Boolean(gameState.countries[group.country].visitors?.[player]);
  if (finalOwner === player && playerAttacked) return `${FACTION_META[player].short} conquered ${countryLabel(group.country)}.`;
  if (allyHeld && playerAttacked) return `${FACTION_META[finalOwner].short} captured ${countryLabel(group.country)} with your support.`;
  if ((finalOwner === player || allyHeld) && playerDefended) return `${countryLabel(group.country)} held. The defence stands.`;
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
      const participant = card.dataset.faction;
      const won = participant === winnerKey || Boolean(finalOwner && gameState.countries[group.country].visitors?.[participant]);
      card.classList.toggle("winner", won);
      card.classList.toggle("fallen", !won);
      $(".battle-position", card).textContent = participant === winnerKey ? "Holds the field" : won ? "Allied support" : "Defeated";
    });
    $("#battle-progress-fill").style.width = "100%";
    $("#battle-result").textContent = battleResultText(group, finalOwner);
    $("#battle-sequence").classList.remove("battle-clash");
    const player = gameState.playerFaction;
    const playerLost = group.events.some((event) => event.attacker === player) && finalOwner !== player
      && !gameState.countries[group.country].visitors?.[player];
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
    <h3>5. Upgrades and spying</h3><p>Country upgrades include AWFDS, Supply Centers, Power Plants, and a faction-specific ability. Supply Centers are only needed—and therefore only offered—in conquered countries where purchasing is not already available. World upgrades unlock decisive faction powers. Intelligence reveals a hidden garrison; Bribery halves its defence for the current year; 00 Agents unlock hits against rival generals.</p>
    <h3>6. General, forces, end turn, and saves</h3><p>The General view lists every controlled-country garrison A–Z, including troops, ships, planes, missiles, and commandos. End Turn lets all computer factions plan, then resolves purchases, construction, moves, resource grants, and battles. Income is collected and neutral armies grow. Campaigns autosave locally after every order. The Save toolbar opens browser save, download, validated upload, and phone-sharing controls. Native sharing can use AirDrop, Quick Share, or Nearby Share where the device supports it; download is the universal fallback.</p>`;
}

function checkEnding() {
  if (!multiplayer) checkVictory(gameState);
  if (multiplayer ? !multiplayer.finished : gameState.status === "playing") return;
  const victory = multiplayer && multiplayer.setup.mode !== "coop" ? gameState.winner === gameState.playerFaction : gameState.status === "victory";
  $("#ending").hidden = false;
  $("#ending-replay").hidden = !gameState.lastReplay?.events.length;
  $("#ending").style.backgroundImage = `linear-gradient(rgba(0,0,0,.25),rgba(0,0,0,.72)), url("${asset(victory ? "victoryScreenBackground.png" : "defeatScreenBackground.png")}")`;
  $("#ending-title").textContent = victory ? "Victory" : "Defeat";
  $("#ending-copy").textContent = victory ? "Your objective is complete. The world has a new order." : "Your last country has fallen. History belongs to another faction.";
  if (multiplayer?.setup.mode === "coop") {
    $("#ending-copy").textContent = victory ? "Your coalition defeated the remaining factions." : "The coalition has lost all of its countries.";
  } else if (multiplayer) {
    $("#ending-title").textContent = victory ? "Victory" : gameState.winner ? "Defeat" : "Draw";
    $("#ending-copy").textContent = gameState.winner ? `${FACTION_META[gameState.winner].short} wins the match.` : "Both players were eliminated.";
  }
}

function activePinchMetrics() {
  const [first, second] = [...mapPointers.values()];
  if (!first || !second) return null;
  const rect = canvas.getBoundingClientRect();
  return {
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    centerX: (first.x + second.x) / 2 - rect.left,
    centerY: (first.y + second.y) / 2 - rect.top,
    canvasWidth: rect.width,
    canvasHeight: rect.height,
  };
}

function beginPinchGesture() {
  const metrics = activePinchMetrics();
  if (!metrics) { pinchGesture = null; return; }
  pinchGesture = { ...metrics, zoom: mapView.zoom, panX: mapView.panX, panY: mapView.panY };
  mapView.dragging = false;
  mapView.moved = 10;
}

function handleMapPointerDown(event) {
  event.preventDefault();
  try { canvas.setPointerCapture(event.pointerId); } catch {}
  mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (mapPointers.size > 1) { beginPinchGesture(); return; }
  pinchGesture = null;
  mapView.dragging = true;
  mapView.moved = 0;
  mapView.lastX = event.clientX;
  mapView.lastY = event.clientY;
}

function handleMapPointerMove(event) {
  if (!mapPointers.has(event.pointerId)) return;
  event.preventDefault();
  mapPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (mapPointers.size > 1) {
    if (!pinchGesture) beginPinchGesture();
    const metrics = activePinchMetrics();
    if (!metrics || !pinchGesture) return;
    Object.assign(mapView, pinchMapView(pinchGesture, metrics));
    drawMap();
    return;
  }
  if (!mapView.dragging) return;
  const dx = event.clientX - mapView.lastX;
  const dy = event.clientY - mapView.lastY;
  mapView.moved += Math.abs(dx) + Math.abs(dy);
  if (mapView.zoom > 1) {
    mapView.panX += dx;
    mapView.panY += dy;
    drawMap();
  }
  mapView.lastX = event.clientX;
  mapView.lastY = event.clientY;
}

function finishMapPointer(event, allowPick) {
  if (!mapPointers.has(event.pointerId)) return;
  const wasSingleTap = allowPick && mapPointers.size === 1 && !pinchGesture && mapView.moved < 6;
  mapPointers.delete(event.pointerId);
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (wasSingleTap) pickCountry(event);
  if (mapPointers.size > 1) beginPinchGesture();
  else if (mapPointers.size === 1) {
    const remaining = [...mapPointers.values()][0];
    pinchGesture = null;
    mapView.dragging = true;
    mapView.moved = 10;
    mapView.lastX = remaining.x;
    mapView.lastY = remaining.y;
  } else {
    pinchGesture = null;
    mapView.dragging = false;
    mapView.moved = 0;
  }
}

function bindEvents() {
  $("#new-game-button").addEventListener("click", () => showScreen("setup-screen"));
  $("#resume-button").addEventListener("click", () => {
    const saved = readSave();
    if (!saved) return;
    sessionSaveBaseline = localStorage.getItem(SAVE_KEY);
    gameState = saved;
    gameData = scenarioData(boardData, saved.scenario);
    selectedCountry = initialCountrySelection(saved.playerFaction);
    showScreen("game-screen");
  });
  $("#multiplayer-button").addEventListener("click", () => openMultiplayer());
  $("#import-save-button").addEventListener("click", () => $("#save-file-input").click());
  $("#save-file-input").addEventListener("change", (event) => importCampaignFile(event.target.files[0]));
  $("#manual-button").addEventListener("click", () => showScreen("manual-screen"));
  $("#about-button").addEventListener("click", () => showScreen("about-screen"));
  $$('[data-screen]').forEach((button) => button.addEventListener("click", () => showScreen(button.dataset.screen)));
  $("#setup-form").addEventListener("submit", (event) => { event.preventDefault(); startCampaign(); });
  $("#campaign-scenario").addEventListener("change", (event) => {
    if (event.target.value) $("#campaign-alliances").checked = true;
    buildFactionOptions();
  });
  $(".dialog-close").addEventListener("click", closeDialog);
  const dialog = $("#command-dialog");
  dialog.addEventListener("close", () => { if (!dialog.open && draftRoute) previewRoute(null); });
  function isBackdrop(event) {
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom);
  }
  let backdropPointer = null;
  dialog.addEventListener("pointerdown", (event) => { backdropPointer = isBackdrop(event) ? event.pointerId : null; });
  dialog.addEventListener("pointerup", (event) => {
    const dismiss = backdropPointer === event.pointerId && isBackdrop(event);
    backdropPointer = null;
    if (dismiss) closeDialog();
  });
  dialog.addEventListener("pointercancel", () => { backdropPointer = null; });
  $("#queue-button").addEventListener("click", openQueue);
  $("#world-upgrades-button").addEventListener("click", openWorldUpgrades);
  $("#espionage-button").addEventListener("click", () => openSpyDialog(selectedCountry));
  $("#objective-button").addEventListener("click", openObjective);
  $("#save-button").addEventListener("click", openSaveManager);
  $("#settings-button").addEventListener("click", openSettings);
  $("#exit-button").addEventListener("click", openExitPrompt);
  $("#end-turn-button").addEventListener("click", async () => {
    if (multiplayer) {
      try {
        await multiplayer.lock();
      } catch (error) {
        notify(error.message || "Could not lock orders. Reconnect from your match save.", "bad");
      }
      return;
    }
    closeReplay();
    const battles = [];
    if (withRules(() => { endTurn(gameData, gameState, battles); notify(`Orders resolved. Year ${gameState.year} begins.`, "good"); })) await playBattleSequence(battles);
  });
  $("#skip-battle").addEventListener("click", () => { battleSkipCurrent = true; stopBattleAudio(); });
  $("#skip-all-battles").addEventListener("click", () => { battleSkipCurrent = battleSkipAll = true; stopBattleAudio(); });
  $(".battle-backdrop").addEventListener("click", () => { battleSkipCurrent = true; stopBattleAudio(); });
  $("#ending-menu").addEventListener("click", () => { $("#ending").hidden = true; if (multiplayer) exitToMenu(false); else showScreen("menu-screen"); });
  $("#ending-replay").addEventListener("click", () => { $("#ending").hidden = true; openReplay(); });
  $("#zoom-in").addEventListener("click", () => {
    const zoom = clampMapZoom(mapView.zoom * 1.5);
    mapView.panX *= zoom / mapView.zoom;
    mapView.panY *= zoom / mapView.zoom;
    mapView.zoom = zoom;
    drawMap();
  });
  $("#zoom-out").addEventListener("click", () => {
    const zoom = clampMapZoom(mapView.zoom / 1.5);
    mapView.panX = zoom === 1 ? 0 : mapView.panX * zoom / mapView.zoom;
    mapView.panY = zoom === 1 ? 0 : mapView.panY * zoom / mapView.zoom;
    mapView.zoom = zoom;
    drawMap();
  });
  $("#reset-map").addEventListener("click", () => { mapView.zoom = 1; mapView.panX = mapView.panY = 0; drawMap(); });
  $("#find-country").addEventListener("click", openCountryFinder);
  $("#diplomacy-button").addEventListener("click", () => openDiplomacy(selectedCountry));
  $("#replay-button").addEventListener("click", openReplay);
  $("#replay-prev").addEventListener("click", () => stepReplay(-1));
  $("#replay-next").addEventListener("click", () => stepReplay(1));
  $("#replay-play").addEventListener("click", toggleReplay);
  $("#replay-close").addEventListener("click", () => { closeReplay(); checkEnding(); });
  canvas.addEventListener("wheel", (event) => { event.preventDefault(); mapView.zoom = clampMapZoom(mapView.zoom * (event.deltaY < 0 ? 1.12 : .9)); if (mapView.zoom === 1) mapView.panX = mapView.panY = 0; drawMap(); }, { passive: false });
  canvas.addEventListener("pointerdown", handleMapPointerDown);
  canvas.addEventListener("pointermove", handleMapPointerMove);
  canvas.addEventListener("pointerup", (event) => finishMapPointer(event, true));
  canvas.addEventListener("pointercancel", (event) => finishMapPointer(event, false));
  canvas.addEventListener("lostpointercapture", (event) => finishMapPointer(event, false));
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

function unlockApp() {
  const key = "wargame-session-access";
  try { if (sessionStorage.getItem(key) === "1") return Promise.resolve(); } catch {}
  const gate = $("#access-gate");
  const field = $("#access-password");
  const form = $("#access-form");
  $("#loading").hidden = true;
  gate.hidden = false;
  field.focus();
  return new Promise((resolve) => {
    function handleSubmit(event) {
      event.preventDefault();
      if (field.value !== "wargame") {
        $("#access-error").textContent = "Incorrect password.";
        field.select();
        return;
      }
      try { sessionStorage.setItem(key, "1"); } catch {}
      form.removeEventListener("submit", handleSubmit);
      field.value = "";
      gate.hidden = true;
      $("#loading").hidden = false;
      resolve();
    }
    form.addEventListener("submit", handleSubmit);
  });
}

async function boot() {
  try {
    await unlockApp();
    [gameData, localization] = await Promise.all([
      fetch("./data/game-data.json").then((response) => response.json()),
      fetch("./data/localization-en.json").then((response) => response.json()),
    ]);
    boardData = gameData;
    prepareMapGeometry();
    buildSetup();
    buildManual();
    bindEvents();
    savePreferences();
    updateResumeButton();
    $("#loading").remove();
    $("#app").hidden = false;
    if (location.hash.startsWith("#match=")) {
      const hash = location.hash;
      history.replaceState(null, "", location.pathname + location.search);
      try { openMultiplayer(parseSignalCode(hash)); }
      catch (error) { notify(error.message, "bad"); }
    }
  } catch (error) {
    $("#loading").innerHTML = `<strong>Unable to load preservation data.</strong><p>${escapeHtml(error.message)}</p>`;
    console.error(error);
  }
}

boot();
