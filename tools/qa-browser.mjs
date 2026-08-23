#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const url = process.argv[2] || "http://127.0.0.1:4317/";
const outputDirectory = path.resolve(process.argv[3] || "preservation/qa");
const debugPort = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
fs.mkdirSync(outputDirectory, { recursive: true });
const profileDirectory = path.join(outputDirectory, `edge-cdp-profile-${process.pid}`);

const edge = spawn(edgePath, [
  "--headless=new",
  "--disable-gpu",
  "--disable-background-mode",
  "--edge-skip-compat-layer-relaunch",
  "--hide-scrollbars",
  "--no-default-browser-check",
  "--no-first-run",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDirectory}`,
  "--window-size=1440,900",
  url,
], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

let browserErrors = "";
edge.stderr.on("data", (chunk) => { browserErrors += chunk.toString(); });
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function findPage() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      const page = pages.find((item) => item.type === "page" && item.url.startsWith(url));
      if (page) return page;
    } catch {}
    await delay(100);
  }
  throw new Error(`Edge debugging endpoint did not start. ${browserErrors}`);
}

const runtimeErrors = [];
let socket;
try {
const page = await findPage();
socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let commandId = 0;
const pending = new Map();
socket.addEventListener("close", () => {
  for (const { reject } of pending.values()) reject(new Error("Edge debugging connection closed."));
  pending.clear();
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  }
  if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.text);
  if (message.method === "Log.entryAdded" && ["error", "warning"].includes(message.params.entry.level)) runtimeErrors.push(message.params.entry.text);
});

function command(method, params = {}) {
  const id = ++commandId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function screenshot(name) {
  const result = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
  fs.writeFileSync(path.join(outputDirectory, name), Buffer.from(result.data, "base64"));
}

await command("Page.enable");
await command("Runtime.enable");
await command("Log.enable");
await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
let appReady = false;
for (let attempt = 0; attempt < 300; attempt += 1) {
  if (await evaluate("Boolean(document.querySelector('#new-game-button')) && !document.querySelector('#loading')")) {
    appReady = true;
    break;
  }
  await delay(100);
}
if (!appReady) throw new Error(`Wargame did not finish loading within 30 seconds. ${JSON.stringify({ runtimeErrors, browserErrors })}`);
await delay(800);

await evaluate("document.querySelector('#new-game-button').click()");
await delay(250);
await screenshot("setup.png");
const setup = await evaluate(`({
  active: document.querySelector('.screen.active')?.id,
  factions: document.querySelectorAll('.faction-option').length,
  objectives: document.querySelectorAll('#objective-select option').length,
  importFromMenu: Boolean(document.querySelector('#import-save-button'))
})`);

await evaluate("document.querySelector('#setup-form').requestSubmit()");
await delay(800);
await screenshot("game-start.png");
const start = await evaluate(`({
  active: document.querySelector('.screen.active')?.id,
  year: document.querySelector('#status-year')?.textContent,
  country: document.querySelector('.country-name')?.textContent,
  canvas: [document.querySelector('#world-map')?.width, document.querySelector('#world-map')?.height],
  cash: document.querySelector('#status-cash')?.textContent
})`);

await evaluate("document.querySelector('#save-button').click()");
await delay(120);
const saveTransfer = await evaluate(`({
  title: document.querySelector('#dialog-title').textContent,
  cards: document.querySelectorAll('.save-transfer-card').length,
  download: Boolean(document.querySelector('#download-save')),
  share: Boolean(document.querySelector('#share-save')),
  upload: Boolean(document.querySelector('#upload-save')),
  safety: document.querySelector('.save-safety')?.textContent || ''
})`);
if (!setup.importFromMenu || saveTransfer.title !== "Save & Transfer" || saveTransfer.cards !== 4 || !saveTransfer.download || !saveTransfer.share || !saveTransfer.upload || !saveTransfer.safety.includes('2 MB')) throw new Error(`Portable save controls failed: ${JSON.stringify(saveTransfer)}.`);
await screenshot("save-transfer.png");
const saveDownload = await evaluate(`(() => {
  const original = HTMLAnchorElement.prototype.click;
  let download = null;
  HTMLAnchorElement.prototype.click = function () { download = { name: this.download, blob: this.href.startsWith('blob:') }; };
  document.querySelector('#download-save').click();
  HTMLAnchorElement.prototype.click = original;
  return download;
})()`);
if (!saveDownload?.name.endsWith('.wargame.json') || !saveDownload.blob) throw new Error(`Save download failed: ${JSON.stringify(saveDownload)}.`);
await evaluate(`(() => {
  const game = JSON.parse(localStorage.getItem('wargame-preservation-save-v1'));
  const file = new File([JSON.stringify({ format: 'wargame-browser-save', exportVersion: 1, exportedAt: new Date().toISOString(), game })], 'phone-transfer.wargame.json', { type: 'application/json' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const input = document.querySelector('#save-file-input');
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await delay(250);
const saveImport = await evaluate(`({
  title: document.querySelector('#dialog-title').textContent,
  source: document.querySelector('#dialog-content')?.textContent || '',
  confirm: Boolean(document.querySelector('#confirm-import')),
  cancel: Boolean(document.querySelector('#cancel-import'))
})`);
if (saveImport.title !== "Load Campaign?" || !saveImport.source.includes('phone-transfer.wargame.json') || !saveImport.confirm || !saveImport.cancel) throw new Error(`Validated save upload failed: ${JSON.stringify(saveImport)}.`);
await evaluate("document.querySelector('#confirm-import').click()");
await delay(120);
const saveImportLoaded = await evaluate(`({
  active: document.querySelector('.screen.active')?.id,
  year: document.querySelector('#status-year')?.textContent,
  localYear: JSON.parse(localStorage.getItem('wargame-preservation-save-v1')).year
})`);
if (saveImportLoaded.active !== 'game-screen' || saveImportLoaded.year !== '2010' || saveImportLoaded.localYear !== 2010) throw new Error(`Validated save did not load: ${JSON.stringify(saveImportLoaded)}.`);

const mapTargets = await evaluate(`(async () => {
  const data = await fetch('./data/game-data.json').then((response) => response.json());
  const rect = document.querySelector('#world-map').getBoundingClientRect();
  const [halfLatitude, halfLongitude] = data.map.halfSize;
  const point = (name) => {
    const country = data.map.countries.find((item) => item.name === name);
    const indices = data.map.indices.slice(country.indexStart, country.indexStart + 3);
    const triangle = indices.map((index) => data.map.vertices[index]);
    const vertex = [
      triangle.reduce((sum, item) => sum + item[0], 0) / 3,
      triangle.reduce((sum, item) => sum + item[1], 0) / 3
    ];
    return {
      x: rect.left + 18 + (halfLongitude - vertex[1]) / (halfLongitude * 2) * (rect.width - 36),
      y: rect.top + 18 + (halfLatitude - vertex[0]) / (halfLatitude * 2) * (rect.height - 36)
    };
  };
  return { russia: point('RUSSIA'), unitedStates: point('UNITED_STATES'), mexico: point('MEXICO') };
})()`);
async function clickMapPoint(point) {
  await evaluate(`document.querySelector('#world-map').dispatchEvent(new PointerEvent('pointerup', {
    clientX: ${JSON.stringify(point.x)}, clientY: ${JSON.stringify(point.y)}, pointerId: 1, bubbles: true
  }))`);
  await delay(100);
}
await clickMapPoint(mapTargets.russia);
const selectedRussia = await evaluate("document.querySelector('.country-name')?.textContent");
if (selectedRussia !== "Russia") throw new Error(`Corrected Russia hit region selected ${selectedRussia} at ${JSON.stringify(mapTargets.russia)}.`);
await clickMapPoint(mapTargets.unitedStates);
const selectedUnitedStates = await evaluate("document.querySelector('.country-name')?.textContent");
if (selectedUnitedStates !== "United States") throw new Error(`Corrected U.S. hit region selected ${selectedUnitedStates} at ${JSON.stringify(mapTargets.unitedStates)}.`);
const mapSelection = { selectedRussia, selectedUnitedStates };

const resourceDisplay = await evaluate("document.querySelector('.country-resource')?.textContent.trim()");
if (!resourceDisplay.includes('$30/year')) throw new Error(`Recovered Finance bonus is missing from the country panel: ${resourceDisplay}.`);

await evaluate("document.querySelector('#objective-button').click()");
await delay(120);
const forceOverview = await evaluate(`(() => {
  const names = [...document.querySelectorAll('[data-force-country]')].map((button) => button.textContent.trim());
  return {
    cards: document.querySelectorAll('.force-country').length,
    names,
    unitCounts: document.querySelectorAll('.force-country:first-child span').length,
    sorted: names.every((name, index) => !index || names[index - 1].localeCompare(name, undefined, { sensitivity: 'base' }) <= 0)
  };
})()`);
if (forceOverview.cards !== 3 || forceOverview.unitCounts !== 5 || !forceOverview.sorted) throw new Error(`Controlled-country force overview failed: ${JSON.stringify(forceOverview)}.`);
await screenshot("forces-overview.png");
await evaluate("document.querySelector('.dialog-close').click(); document.querySelector('#move-action').click(); const unit=document.querySelector('#move-unit'); unit.value='planes'; unit.dispatchEvent(new Event('change',{bubbles:true}))");
await delay(80);
const targetOrdering = await evaluate(`(() => {
  const options = [...document.querySelectorAll('#move-target option')];
  const labels = options.map((option) => option.textContent.replace(/ — (move|attack)$/, ''));
  return {
    count: options.length,
    sorted: labels.every((label, index) => !index || labels[index - 1].localeCompare(label, undefined, { sensitivity: 'base' }) <= 0),
    controlledRegular: options.filter((option) => option.classList.contains('controlled-option')).every((option) => !option.classList.contains('uncontrolled-option')),
    uncontrolledItalic: options.filter((option) => option.classList.contains('uncontrolled-option')).every((option) => getComputedStyle(option).fontStyle === 'italic'),
    uncontrolledCount: options.filter((option) => option.classList.contains('uncontrolled-option')).length
  };
})()`);
if (!targetOrdering.sorted || !targetOrdering.controlledRegular || !targetOrdering.uncontrolledItalic || !targetOrdering.uncontrolledCount) throw new Error(`A–Z target ordering or ownership styling failed: ${JSON.stringify(targetOrdering)}.`);
await evaluate("document.querySelector('.dialog-close').click()");

await evaluate(`(() => {
  document.querySelector('#move-action').click();
  const unit = document.querySelector('#move-unit');
  unit.value = 'ships';
  unit.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('#move-target').value = 'ALASKA';
  document.querySelector('#move-quantity').value = '2';
  document.querySelector('#move-form').requestSubmit();
})()`);
await delay(120);
const transportDialog = await evaluate(`({
  title: document.querySelector('#dialog-title').textContent,
  capacity: document.querySelector('#board-quantity')?.max,
  route: document.querySelector('#board-route')?.selectedOptions[0]?.textContent
})`);
if (transportDialog.title !== "Board Troops" || transportDialog.capacity !== "2") throw new Error(`Naval boarding flow failed: ${JSON.stringify(transportDialog)}.`);
await evaluate("document.querySelector('#board-quantity').value='2'; document.querySelector('#board-form').requestSubmit()");
await delay(120);

await evaluate("document.querySelector('#buy-action').click()");
await delay(120);
const dialog = await evaluate(`({
  open: document.querySelector('#command-dialog').open,
  title: document.querySelector('#dialog-title').textContent,
  units: document.querySelectorAll('#buy-unit option').length,
  hasQuantity: Boolean(document.querySelector('#buy-quantity')),
  content: document.querySelector('#dialog-content').textContent
})`);
if (!dialog.hasQuantity) throw new Error(`Buy dialog failed to render: ${JSON.stringify({ dialog, runtimeErrors })}`);
await evaluate("document.querySelector('#buy-form').noValidate=true; document.querySelector('#buy-quantity').value='1.5'; document.querySelector('#buy-form').requestSubmit()");
await delay(120);
const rejectedOrder = await evaluate(`({
  dialogOpen: document.querySelector('#command-dialog').open,
  queue: document.querySelector('#queue-count').textContent,
  error: document.querySelector('#toast').textContent
})`);
if (!rejectedOrder.dialogOpen || rejectedOrder.queue !== "1") throw new Error(`Rejected order changed state or closed its dialog: ${JSON.stringify(rejectedOrder)}.`);
await evaluate("document.querySelector('#buy-quantity').value='1'; document.querySelector('#buy-form').requestSubmit()");
await delay(120);

await evaluate("document.querySelector('#country-upgrade-action').click()");
await delay(120);
await evaluate("document.querySelector('[data-mode=\"country\"][data-upgrade=\"6\"]')?.click()");
await delay(120);
const persistentUpgrade = await evaluate(`({
  open: document.querySelector('#command-dialog').open,
  title: document.querySelector('#dialog-title').textContent,
  queuedLabel: document.querySelector('[data-mode="country"][data-upgrade="6"]')?.textContent
})`);
if (!persistentUpgrade.open || persistentUpgrade.queuedLabel !== "Queued ✓") throw new Error(`Upgrade dialog did not remain open with queued state: ${JSON.stringify(persistentUpgrade)}.`);
await evaluate("document.querySelector('.dialog-close').click()");

await clickMapPoint(mapTargets.mexico);
await evaluate("document.querySelector('#attack-country-action').click()");
await delay(120);
const attackPlanner = await evaluate(`(() => {
  const sources = [...document.querySelectorAll('#attack-source option')].map((option) => option.textContent.trim());
  return {
    title: document.querySelector('#dialog-title').textContent,
    sources,
    sorted: sources.every((name, index) => !index || sources[index - 1].localeCompare(name, undefined, { sensitivity: 'base' }) <= 0),
    targetAction: document.querySelector('#attack-country-action')?.textContent
  };
})()`);
if (attackPlanner.title !== "Attack Mexico" || !attackPlanner.sorted || !attackPlanner.sources.includes("United States")) throw new Error(`Target-first attack planner failed: ${JSON.stringify(attackPlanner)}.`);
await screenshot("attack-planner.png");
await evaluate(`(() => {
  const source = document.querySelector('#attack-source');
  source.value = 'UNITED_STATES';
  source.dispatchEvent(new Event('change', { bubbles: true }));
  const unit = document.querySelector('#attack-unit');
  unit.value = 'troops';
  unit.dispatchEvent(new Event('change', { bubbles: true }));
  document.querySelector('#attack-quantity').value = '40';
  document.querySelector('#attack-form').requestSubmit();
})()`);
await delay(120);
const attackCommitment = await evaluate(`({
  dialogOpen: document.querySelector('#command-dialog').open,
  commitments: document.querySelectorAll('.attack-commitments > div').length,
  text: document.querySelector('.attack-commitments')?.textContent
})`);
if (!attackCommitment.dialogOpen || attackCommitment.commitments !== 1 || !attackCommitment.text.includes('United States')) throw new Error(`Multi-source attack commitment failed: ${JSON.stringify(attackCommitment)}.`);
await evaluate("document.querySelector('.dialog-close').click()");
const queued = await evaluate("document.querySelector('#queue-count').textContent");
await evaluate("document.querySelector('#end-turn-button').click()");
await delay(700);
const battleAnimation = await evaluate(`({
  visible: !document.querySelector('#battle-sequence').hidden,
  title: document.querySelector('#battle-title').textContent,
  factions: document.querySelectorAll('.battle-faction').length,
  route: document.querySelector('#battle-route').textContent,
  transparentOverlay: getComputedStyle(document.querySelector('#battle-sequence')).backgroundColor === 'rgba(0, 0, 0, 0)',
  hudBackground: getComputedStyle(document.querySelector('.battle-hud')).backgroundImage
})`);
if (!battleAnimation.visible || battleAnimation.factions < 2 || !battleAnimation.route.includes('Mexico') || !battleAnimation.transparentOverlay || !battleAnimation.hudBackground.includes('rgba')) {
  const battleDebug = await evaluate(`({ year: document.querySelector('#status-year').textContent, queue: document.querySelector('#queue-count').textContent, dialog: document.querySelector('#dialog-title').textContent, toast: document.querySelector('#toast').textContent })`);
  throw new Error(`Combat presentation did not start: ${JSON.stringify({ battleAnimation, battleDebug, queued, runtimeErrors })}.`);
}
await screenshot("battle-animation.png");
for (let attempt = 0; attempt < 45; attempt += 1) {
  if (await evaluate("document.querySelectorAll('.battle-faction.fallen').length > 0")) break;
  await delay(40);
}
const battleResult = await evaluate(`({
  visible: !document.querySelector('#battle-sequence').hidden,
  winner: document.querySelectorAll('.battle-faction.winner').length,
  fallen: document.querySelectorAll('.battle-faction.fallen').length,
  result: document.querySelector('#battle-result').textContent,
  progress: document.querySelector('#battle-progress-fill').style.width
})`);
if (battleResult.winner !== 1 || battleResult.fallen < 1 || battleResult.progress !== "100%") throw new Error(`Combat result presentation failed: ${JSON.stringify(battleResult)}.`);
await screenshot("battle-result.png");
await evaluate("document.querySelector('#skip-all-battles').click()");
for (let attempt = 0; attempt < 40; attempt += 1) {
  if (await evaluate("document.querySelector('#battle-sequence').hidden")) break;
  await delay(100);
}
await screenshot("game-after-turn.png");
const afterTurn = await evaluate(`({ year: document.querySelector('#status-year').textContent, queue: document.querySelector('#queue-count').textContent, cash: document.querySelector('#status-cash').textContent, resourceLog: [...document.querySelectorAll('.log-item strong')].some((item) => item.textContent.includes('Country resources delivered')) })`);

await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await evaluate("window.dispatchEvent(new Event('resize'))");
await delay(350);
await screenshot("game-mobile.png");
const mobile = await evaluate(`({
  viewport: [innerWidth, innerHeight],
  bodyWidth: document.body.scrollWidth,
  panelVisible: document.querySelector('#country-panel').classList.contains('has-selection'),
  canvasWidth: Math.round(document.querySelector('#world-map').getBoundingClientRect().width),
  toolbar: (() => {
    const bar = document.querySelector('.command-bar');
    const buttons = [...bar.querySelectorAll('button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { id: button.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
    return { clientWidth: bar.clientWidth, scrollWidth: bar.scrollWidth, buttons };
  })(),
  countryActions: [...document.querySelectorAll('.country-actions button')].map((button) => {
    const rect = button.getBoundingClientRect();
    return { id: button.id, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
  })
})`);
if (mobile.bodyWidth > mobile.viewport[0]) throw new Error(`Mobile page overflows horizontally: ${JSON.stringify(mobile)}.`);
if (mobile.toolbar.scrollWidth > mobile.toolbar.clientWidth) throw new Error(`Mobile toolbar requires horizontal scrolling: ${JSON.stringify(mobile.toolbar)}.`);
for (const button of mobile.toolbar.buttons) {
  if (button.left < 0 || button.right > mobile.viewport[0] || button.top < 0 || button.bottom > mobile.viewport[1] || button.height < 44) {
    throw new Error(`Mobile command is not fully reachable: ${JSON.stringify(button)}.`);
  }
}
for (const button of mobile.countryActions) {
  if (button.left < 0 || button.right > mobile.viewport[0] || button.top < 0 || button.bottom > mobile.viewport[1] || button.height < 44) {
    throw new Error(`Mobile country action is not fully reachable: ${JSON.stringify(button)}.`);
  }
}

await evaluate("document.querySelector('#objective-button').click()");
await delay(120);
const mobileForces = await evaluate(`(() => {
  const dialog = document.querySelector('#command-dialog').getBoundingClientRect();
  const first = document.querySelector('.force-country').getBoundingClientRect();
  return { cards: document.querySelectorAll('.force-country').length, dialog: { left: dialog.left, right: dialog.right, top: dialog.top, bottom: dialog.bottom }, firstWidth: first.width, resourceLog: [...document.querySelectorAll('.log-item strong')].some((item) => item.textContent.includes('Country resources delivered')) };
})()`);
if (mobileForces.cards < 3 || mobileForces.dialog.left < 0 || mobileForces.dialog.right > mobile.viewport[0] || mobileForces.firstWidth > mobile.viewport[0] || !mobileForces.resourceLog) throw new Error(`Mobile force overview or resource report is not reachable: ${JSON.stringify(mobileForces)}.`);
await screenshot("forces-mobile.png");
await evaluate("document.querySelector('[data-force-country=\"UNITED_STATES\"]').click(); document.querySelector('#settings-button').click()");
await delay(120);
const settingsDialog = await evaluate(`({ title: document.querySelector('#dialog-title').textContent, toggles: document.querySelectorAll('.setting-row input').length })`);
if (settingsDialog.title !== "Settings" || settingsDialog.toggles !== 2) throw new Error(`Settings dialog failed: ${JSON.stringify(settingsDialog)}.`);
await evaluate("document.querySelector('.dialog-close').click(); document.querySelector('#save-button').click()");
await delay(120);
const mobileSave = await evaluate(`(() => {
  const dialog = document.querySelector('#command-dialog').getBoundingClientRect();
  const cards = [...document.querySelectorAll('.save-transfer-card')].map((item) => {
    const rect = item.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  return { title: document.querySelector('#dialog-title').textContent, dialog: { left: dialog.left, right: dialog.right }, cards };
})()`);
if (mobileSave.title !== "Save & Transfer" || mobileSave.dialog.left < 0 || mobileSave.dialog.right > mobile.viewport[0] || mobileSave.cards.length !== 4 || mobileSave.cards.some((card) => card.width > mobile.viewport[0] || card.height < 44)) throw new Error(`Mobile save transfer controls failed: ${JSON.stringify(mobileSave)}.`);
await screenshot("save-transfer-mobile.png");
await evaluate("document.querySelector('.dialog-close').click(); document.querySelector('#exit-button').click()");
await delay(120);
const exitDialog = await evaluate(`({ title: document.querySelector('#dialog-title').textContent, actions: document.querySelectorAll('.exit-actions button').length })`);
if (exitDialog.actions !== 3) throw new Error(`Exit confirmation failed: ${JSON.stringify(exitDialog)}.`);
await evaluate("document.querySelector('#stay-game').click()");

await evaluate("document.querySelector('#buy-action').click()");
await delay(120);
const mobileDialog = await evaluate(`(() => {
  const dialog = document.querySelector('#command-dialog').getBoundingClientRect();
  const quantity = document.querySelector('#buy-quantity').getBoundingClientRect();
  const submit = document.querySelector('#buy-form .primary-button').getBoundingClientRect();
  return { dialog: { left: dialog.left, right: dialog.right, top: dialog.top, bottom: dialog.bottom }, quantityHeight: quantity.height, submitHeight: submit.height };
})()`);
if (mobileDialog.dialog.left < 0 || mobileDialog.dialog.right > mobile.viewport[0] || mobileDialog.dialog.top < 0 || mobileDialog.dialog.bottom > mobile.viewport[1] || mobileDialog.quantityHeight < 44 || mobileDialog.submitHeight < 44) {
  throw new Error(`Mobile dialog controls are not fully reachable: ${JSON.stringify(mobileDialog)}.`);
}
await screenshot("dialog-mobile.png");

console.log(JSON.stringify({ setup, start, saveTransfer, saveDownload, saveImport, saveImportLoaded, mapSelection, resourceDisplay, forceOverview, targetOrdering, transportDialog, dialog, rejectedOrder, persistentUpgrade, attackPlanner, attackCommitment, queued, battleAnimation, battleResult, afterTurn, mobile, mobileForces, settingsDialog, mobileSave, exitDialog, mobileDialog, runtimeErrors }, null, 2));
} finally {
  try { socket?.close(); } catch {}
  if (process.platform === "win32" && edge.pid) {
    const terminator = spawn("taskkill", ["/pid", String(edge.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await Promise.race([new Promise((resolve) => terminator.once("exit", resolve)), delay(4000)]);
  } else {
    if (!edge.killed) edge.kill();
    await Promise.race([new Promise((resolve) => edge.once("exit", resolve)), delay(2000)]);
  }
  if (process.platform === "win32") {
    const remover = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "& { param([string]$target) Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop }",
      profileDirectory,
    ], { stdio: "ignore", windowsHide: true });
    const removalCode = await Promise.race([new Promise((resolve) => remover.once("exit", resolve)), delay(10000).then(() => null)]);
    if (removalCode !== 0) throw new Error(`Could not remove temporary browser profile ${profileDirectory}.`);
  } else fs.rmSync(profileDirectory, { recursive: true, force: true });
}
if (runtimeErrors.length) process.exitCode = 1;
