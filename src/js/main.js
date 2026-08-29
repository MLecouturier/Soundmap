import { initI18n, t, translateError, getLocale, setLocale, AVAILABLE_LOCALES, applyTranslations } from './i18n.js';

const { invoke } = window.__TAURI__.core;

await initI18n();

// ---------- Language switcher ----------
function renderLanguageSwitcher() {
    const container = document.querySelector('#language-switcher');
    if (!container) return;
    const current = getLocale();
    container.innerHTML = `
        <select id="language-select" aria-label="Language">
            ${AVAILABLE_LOCALES.map(l => {
                // We read each locale's own display name via a tiny lookup,
                // falling back to the code if unavailable.
                return `<option value="${l.code}" ${l.code === current ? 'selected' : ''}>${localeDisplayName(l.code)}</option>`;
            }).join('')}
        </select>
    `;
    container.querySelector('#language-select').addEventListener('change', (e) => {
        setLocale(e.target.value);
    });
}

// Display names are hardcoded here (not translated) so a language always
// shows its own name (e.g. "Français" stays "Français" no matter the
// active locale). Add an entry here when adding a new language.
const LOCALE_DISPLAY_NAMES = { en: 'English', fr: 'Français' };
function localeDisplayName(code) {
    return LOCALE_DISPLAY_NAMES[code] || code.toUpperCase();
}

renderLanguageSwitcher();

// Updates a synth's play/stop button: icon, label, and active state stay
// in sync, whatever the trigger (click, locale change, remote event, ...).
function setPlayButtonState(btn, playing) {
    btn.classList.toggle('active', playing);
    btn.querySelector('.synth-play-icon').textContent = playing ? 'pause' : 'play_arrow';
    btn.querySelector('.synth-play-label').textContent = playing ? t('synth.stop') : t('synth.play');
}

// Re-translates an existing synth card: static parts via data-i18n*, plus
// the few labels whose text depends on dynamic state (play/stop, mode,
// threshold "off" state) that data-i18n alone can't express.
function retranslateSynthElement(el) {
    applyTranslations(el);

    const id = Number(el.dataset.synthId);
    el.querySelector('.synth-title-label').textContent = t('synth.title', { id });

    const playBtn = el.querySelector('.synth-play');
    setPlayButtonState(playBtn, playBtn.classList.contains('active'));

    el.querySelector('.synth-loop-label').textContent = t('synth.loop');

    el.querySelector('.synth-mode-btn[data-mode="monophonic"]').textContent = t('synth.modeMonophonic');
    el.querySelector('.synth-mode-btn[data-mode="polyphonic"]').textContent = t('synth.modePolyphonic');

    const thresholdInput = el.querySelector('.synth-threshold');
    const thresholdVal = el.querySelector('.threshold-val');
    thresholdVal.textContent = Number(thresholdInput.value) === 0
        ? t('synth.noteThresholdOff')
        : thresholdInput.value;

    // Pixel info: only reset to the empty placeholder if no tick has been
    // received yet (i.e. it still shows the untranslated empty state).
    const pixelInfo = el.querySelector('.synth-pixel-info');
    if (!pixelInfo.dataset.hasTick) {
        pixelInfo.textContent = t('synth.pixelInfoEmpty');
    }
}

// Re-apply translations everywhere (static markup + dynamically created
// synth cards) whenever the locale changes.
window.addEventListener('locale-changed', () => {
    renderLanguageSwitcher();
    document.querySelectorAll('.synth-block').forEach(el => retranslateSynthElement(el));
    if (typeof syncLabels === 'function') syncLabels();
    if (lastDimensionsInfo) dimensionsInfo.textContent = t('controls.dimensionsInfo', lastDimensionsInfo);
    if (typeof syncPlayAllButton === 'function') syncPlayAllButton();
});

// ---------- Elements ----------
const loadBtn         = document.querySelector('#load-btn');
const resetBtn        = document.querySelector('#reset-btn');
const showOriginal    = document.querySelector('#show-original');
const preview         = document.querySelector('#preview');
const viewerEmpty     = document.querySelector('#viewer-empty');
const pixelOverlay    = document.querySelector('#pixel-overlay');

const gridSlider      = document.querySelector('#grid-width');
const gridValue       = document.querySelector('#grid-width-value');

const grayscale       = document.querySelector('#grayscale');
const contrast        = document.querySelector('#contrast');
const contrastValue   = document.querySelector('#contrast-value');
const brightness      = document.querySelector('#brightness');
const brightnessValue = document.querySelector('#brightness-value');
const posterize       = document.querySelector('#posterize');
const posterizeValue  = document.querySelector('#posterize-value');

const dimensionsInfo  = document.querySelector('#dimensions-info');

// Image controls to lock while a synthesizer is playing
// (the "Show original" button is intentionally excluded)
const imageLockControls = [loadBtn, resetBtn, gridSlider, contrast, brightness, grayscale, posterize];

// Locks/unlocks image controls depending on whether a synth is playing
function updateImageControlsLockState() {
    const anyPlaying = synthListBody.querySelectorAll('.synth-play.active').length > 0;
    imageLockControls.forEach(el => { el.disabled = anyPlaying; });
    document.querySelector('#controls').classList.toggle('locked', anyPlaying);
}

// ---------- Canvas overlay ----------
let gridW = 1; // current grid width in pixels
let gridH = 1; // current grid height in pixels

// Tracks the current cursor per synth for drawing: Map<id, cursor>
const synthCursors = new Map();

function resizeOverlay() {
    pixelOverlay.width  = pixelOverlay.offsetWidth;
    pixelOverlay.height = pixelOverlay.offsetHeight;
}

function drawSynthPixel(synthId, cursor, muted) {
    if (!hasImage) return;
    const color = synthColors.get(synthId);
    if (!color) return;

    const ctx = pixelOverlay.getContext('2d');

    // Rendered dimensions of the image in the viewer (object-fit: contain)
    const vw = pixelOverlay.width;
    const vh = pixelOverlay.height;
    const imgRatio = gridW / gridH;
    const viewRatio = vw / vh;

    let renderW, renderH, offsetX, offsetY;
    if (imgRatio > viewRatio) {
        renderW = vw;
        renderH = vw / imgRatio;
    } else {
        renderH = vh;
        renderW = vh * imgRatio;
    }
    offsetX = (vw - renderW) / 2;
    offsetY = (vh - renderH) / 2;

    const cellW = renderW / gridW;
    const cellH = renderH / gridH;
    const col = cursor % gridW;
    const row = Math.floor(cursor / gridW);
    const x = offsetX + col * cellW;
    const y = offsetY + row * cellH;

    // Only clear the previous pixel of this synth
    const prev = synthCursors.get(synthId);
    if (prev !== undefined) {
        const pc = prev % gridW;
        const pr = Math.floor(prev / gridW);
        ctx.clearRect(
            offsetX + pc * cellW - 1,
            offsetY + pr * cellH - 1,
            cellW + 2, cellH + 2
        );
        // Redraw other synths that occupy this pixel
        synthCursors.forEach((c, sid) => {
            if (sid !== synthId && c === prev) drawPixelAt(ctx, sid, c, offsetX, offsetY, cellW, cellH);
        });
    }

    synthCursors.set(synthId, cursor);
    if (!muted) drawPixelAt(ctx, synthId, cursor, offsetX, offsetY, cellW, cellH);
}

function drawPixelAt(ctx, synthId, cursor, offsetX, offsetY, cellW, cellH) {
    const color = synthColors.get(synthId);
    if (!color) return;
    const col = cursor % gridW;
    const row = Math.floor(cursor / gridW);
    const x = offsetX + col * cellW;
    const y = offsetY + row * cellH;
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, cellW, cellH);
    ctx.restore();
}

function clearOverlay() {
    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    synthCursors.clear();
}

// ---------- Mouse-based pixel range selection ----------
// Only one synth can be in selection mode at a time.
let rangePickState = null; // { id, btn, firstPixel: number|null }

function cursorFromClientPoint(clientX, clientY) {
    const layout = getImageLayout();
    if (!layout) return null;
    const rect = pixelOverlay.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const { offsetX, offsetY, cellW, cellH } = layout;

    const col = Math.floor((px - offsetX) / cellW);
    const row = Math.floor((py - offsetY) / cellH);
    if (col < 0 || row < 0 || col >= gridW || row >= gridH) return null;

    return row * gridW + col;
}

function startRangePicking(id, btn) {
    // Cancel any selection mode already active on another synth
    if (rangePickState && rangePickState.id !== id) {
        cancelRangePicking();
    }
    rangePickState = { id, btn, firstPixel: null };
    btn.classList.add('active');
    pixelOverlay.classList.add('picking');
}

function cancelRangePicking() {
    if (!rangePickState) return;
    rangePickState.btn.classList.remove('active');
    pixelOverlay.classList.remove('picking');
    rangePickState = null;
}

pixelOverlay.addEventListener('click', (e) => {
    if (!rangePickState || !hasImage) return;
    const cursor = cursorFromClientPoint(e.clientX, e.clientY);
    if (cursor === null) return;

    const { id, firstPixel } = rangePickState;

    if (firstPixel === null) {
        // First click: remember the start pixel
        rangePickState.firstPixel = cursor;
        return;
    }

    // Second click: define the range (with inversion if necessary)
    const start = Math.min(firstPixel, cursor);
    const end   = Math.max(firstPixel, cursor);
    applySynthRangeFromPicker(id, start, end);
    cancelRangePicking();
});

function applySynthRangeFromPicker(id, start, end) {
    const el = synthListBody.querySelector(`[data-synth-id="${id}"]`);
    if (!el) return;
    const startInput = el.querySelector('.range-start');
    const endInput   = el.querySelector('.range-end');
    const startVal   = el.querySelector('.range-start-val');
    const endVal     = el.querySelector('.range-end-val');

    startInput.value = start;
    endInput.value   = end;
    startVal.textContent = start;
    endVal.textContent   = end;

    // Triggers the fill update, the highlight update, and the Rust call
    startInput.dispatchEvent(new Event('input'));
    endInput.dispatchEvent(new Event('input'));
}

// Computes the render dimensions of the image in the viewer (object-fit: contain)
function getImageLayout() {
    const vw = pixelOverlay.width;
    const vh = pixelOverlay.height;
    if (!gridW || !gridH || !vw || !vh) return null;
    const imgRatio  = gridW / gridH;
    const viewRatio = vw / vh;
    let renderW, renderH;
    if (imgRatio > viewRatio) { renderW = vw; renderH = vw / imgRatio; }
    else                      { renderH = vh; renderW = vh * imgRatio; }
    return {
        renderW, renderH,
        offsetX: (vw - renderW) / 2,
        offsetY: (vh - renderH) / 2,
        cellW: renderW / gridW,
        cellH: renderH / gridH,
    };
}

function drawRangeHighlight(synthId) {
    const hi = synthHighlights.get(synthId);
    if (!hi || !hi.visible) return;
    const layout = getImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, cellW, cellH } = layout;
    const color = synthColors.get(synthId);
    if (!color) return;

    const ctx = pixelOverlay.getContext('2d');
    const start = hi.start;
    const end   = hi.end > 0 ? hi.end : totalPixels - 1;

    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle   = color;
    for (let i = start; i <= end; i++) {
        const col = i % gridW;
        const row = Math.floor(i / gridW);
        ctx.fillRect(offsetX + col * cellW, offsetY + row * cellH, cellW, cellH);
    }
    ctx.restore();
}

function clearRangeHighlight(synthId) {
    // We redraw the whole canvas from scratch (safer than targeting individual areas)
    redrawAllHighlights();
}

function redrawAllHighlights() {
    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    synthCursors.clear(); // active cursors will be redrawn on the next tick
    synthHighlights.forEach((_, sid) => drawRangeHighlight(sid));
}

// ---------- Color channel preview (hovering the R/G/B buttons) ----------
// channelIndex: 0 = red, 1 = green, 2 = blue
const CHANNEL_TINTS = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
];

function drawChannelOverlay(channelIndex) {
    if (!hasImage || !cachedPixelData) return;
    const layout = getImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, renderW, renderH } = layout;
    const { width, height, pixels } = cachedPixelData;
    if (!width || !height) return;

    // Build an offscreen canvas at the grid's resolution, where each pixel
    // reflects the intensity of the chosen channel, tinted with its color.
    const offCanvas = document.createElement('canvas');
    offCanvas.width = width;
    offCanvas.height = height;
    const offCtx = offCanvas.getContext('2d');
    const imageData = offCtx.createImageData(width, height);
    const [tr, tg, tb] = CHANNEL_TINTS[channelIndex];

    for (let i = 0; i < width * height; i++) {
        const value = pixels[i * 4 + channelIndex];
        const o = i * 4;
        imageData.data[o]     = (tr * value) / 255;
        imageData.data[o + 1] = (tg * value) / 255;
        imageData.data[o + 2] = (tb * value) / 255;
        imageData.data[o + 3] = 255;
    }
    offCtx.putImageData(imageData, 0, 0);

    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offCanvas, offsetX, offsetY, renderW, renderH);
    ctx.restore();
}

function hideChannelOverlay() {
    redrawAllHighlights();
}

new ResizeObserver(() => {
    resizeOverlay();
    clearOverlay();
}).observe(pixelOverlay);

// ---------- State ----------
let hasImage      = false;
let origWidth     = 0;
let origHeight    = 0;
let originalPng   = null;   // base64 of the original preview
let processedPng  = null;   // base64 of the last processed render
let totalPixels   = 0;      // total number of pixels in the current grid

// Cache of the processed image's raw pixels (flat RGBA), for the channel preview
let cachedPixelData = null; // { width, height, pixels: Uint8ClampedArray-like }

async function refreshPixelDataCache() {
    try {
        cachedPixelData = await invoke('get_pixel_data');
    } catch (err) {
        cachedPixelData = null;
    }
}

// Predefined colors for the synths
const SYNTH_COLORS = [
    '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
    '#1abc9c', '#3498db', '#9b59b6', '#e91e63',
    '#ff5722', '#00bcd4', '#8bc34a', '#ffffff',
];

// Map id → current color
const synthColors = new Map();

// Map id → { visible: bool, start: number, end: number }
const synthHighlights = new Map();

const SLIDER_STEPS = 1000;
const MIN_CELLS    = 2;

// ---------- Logarithmic scale ----------
function sliderToCells(v, maxCells) {
  if (!maxCells || maxCells < MIN_CELLS) return MIN_CELLS;
  const lmin = Math.log(MIN_CELLS);
  const lmax = Math.log(maxCells);
  const cells = Math.round(Math.exp(lmin + (lmax - lmin) * (v / SLIDER_STEPS)));
  return Number.isFinite(cells)
    ? Math.min(maxCells, Math.max(MIN_CELLS, cells))
    : MIN_CELLS;
}

function currentGridWidth() {
  return sliderToCells(Number(gridSlider.value), origWidth);
}

// ---------- Settings ----------
function buildParams() {
  const levels = Number(posterize.value);
  return {
    grid_width:       currentGridWidth(),
    grid_height:      null,              // always deduced from the ratio
    contrast:         Number(contrast.value),
    brightness:       Number(brightness.value),
    grayscale:        grayscale.checked,
    posterize_levels: levels > 1 ? levels : null,
  };
}

// ---------- Display ----------
function updatePreviewSrc() {
  const showOrig = showOriginal.checked;
  const data = showOrig ? originalPng : processedPng;
  if (!data) return;
  preview.src = `data:image/png;base64,${data}`;
  preview.classList.toggle('pixelated', !showOrig);
}

function syncLabels() {
  gridValue.textContent       = hasImage ? currentGridWidth() : '-';
  contrastValue.textContent   = Number(contrast.value).toFixed(0);
  brightnessValue.textContent = Number(brightness.value).toFixed(0);

  const p = Number(posterize.value);
  posterizeValue.textContent = p > 1 ? t('controls.posterizeLevels', { count: p }) : t('controls.posterizeOff');
}

// ---------- Refresh ----------
let pending = false;
let lastDimensionsInfo = null; // remembers the last result, to retranslate on locale change

async function refresh() {
  if (!hasImage || pending) return;
  pending = true;

  try {
    const result = await invoke('apply_image_adjustments', {
      params: buildParams(),
    });

    processedPng = result.base64_png;
    updatePreviewSrc();

    totalPixels = result.cell_count;
    gridW = result.width;
    gridH = result.height;
    clearOverlay();
    cancelRangePicking();
    updateAllSynthRangeMax(totalPixels);
    await refreshPixelDataCache();

    lastDimensionsInfo = {
      origWidth, origHeight,
      width: result.width, height: result.height,
      cellCount: result.cell_count,
    };
    dimensionsInfo.textContent = t('controls.dimensionsInfo', lastDimensionsInfo);
  } catch (err) {
    console.error('Error while processing:', err);
    dimensionsInfo.textContent = translateError(err);
  } finally {
    pending = false;
  }
}

let debounceId = null;
function scheduleRefresh(delay = 60) {
  clearTimeout(debounceId);
  debounceId = setTimeout(refresh, delay);
}

// ---------- Loading ----------
loadBtn.addEventListener('click', async () => {
  try {
    const result = await invoke('load_image');
    if (!result) return;

    origWidth   = result.orig_width;
    origHeight  = result.orig_height;
    originalPng = result.base64_png;
    hasImage    = true;

    gridSlider.value      = SLIDER_STEPS;
    showOriginal.checked  = false;

    viewerEmpty.classList.add('hidden');
    preview.classList.remove('hidden');

    syncLabels();
    await refresh();
  } catch (err) {
    console.error('Error while loading the image:', err);
    dimensionsInfo.textContent = translateError(err);
  }
});

// ---------- Reset ----------
resetBtn.addEventListener('click', () => {
  gridSlider.value  = SLIDER_STEPS;
  grayscale.checked = false;
  contrast.value    = 0;
  brightness.value  = 0;
  posterize.value   = 1;

  syncLabels();
  refresh();
});

// ---------- Listeners ----------
[gridSlider, contrast, brightness, posterize].forEach(el => {
  el.addEventListener('input', () => {
    syncLabels();
    scheduleRefresh();
  });
});

grayscale.addEventListener('change', () => {
  syncLabels();
  scheduleRefresh(0);
});

showOriginal.addEventListener('change', updatePreviewSrc);

// ---------- Init ----------
syncLabels();

// ---------- Metronome ----------
const bpmInput = document.querySelector('#bpm-input');
const bpmMinus10 = document.querySelector('#bpm-minus10');
const bpmMinus1  = document.querySelector('#bpm-minus1');
const bpmPlus1   = document.querySelector('#bpm-plus1');
const bpmPlus10  = document.querySelector('#bpm-plus10');
const metronomeLed = document.querySelector('#metronome-led');

const BPM_MIN = 20;
const BPM_MAX = 300;

let metronomeRunning = false;

function clampBpm(value) {
    return Math.min(BPM_MAX, Math.max(BPM_MIN, value));
}

async function applyBpm(newBpm) {
    const clamped = clampBpm(newBpm);
    bpmInput.value = clamped;
    if (metronomeRunning) {
        await invoke('set_metronome_bpm', { bpm: clamped });
    }
}

// Starts the Rust metronome if it's not already running
async function ensureMetronomeStarted() {
    if (metronomeRunning) return;
    await invoke('set_metronome_bpm', { bpm: clampBpm(Number(bpmInput.value)) });
    await invoke('start_metronome');
    metronomeRunning = true;
}

// Stops the Rust metronome if no synth is playing anymore
async function stopMetronomeIfIdle() {
    if (!metronomeRunning) return;
    const anyPlaying = synthListBody.querySelectorAll('.synth-play.active').length > 0;
    if (anyPlaying) return;

    await invoke('stop_metronome');
    metronomeRunning = false;

    // Restore the highlights hidden during playback
    synthListBody.querySelectorAll('.synth-block').forEach(el => {
        const sid = Number(el.dataset.synthId);
        synthCursors.delete(sid);
        const hi = synthHighlights.get(sid);
        if (hi && hi._wasVisible) { hi.visible = true; hi._wasVisible = false; }
    });
    redrawAllHighlights();
}

bpmMinus10.addEventListener('click', () => applyBpm(Number(bpmInput.value) - 10));
bpmMinus1.addEventListener('click',  () => applyBpm(Number(bpmInput.value) - 1));
bpmPlus1.addEventListener('click',   () => applyBpm(Number(bpmInput.value) + 1));
bpmPlus10.addEventListener('click',  () => applyBpm(Number(bpmInput.value) + 10));

// Direct keyboard input: validated on blur or on "Enter"
bpmInput.addEventListener('change', () => applyBpm(Number(bpmInput.value)));

// Keyboard support: ↑/↓ arrows to increment/decrement by 1
bpmInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
        event.preventDefault(); // prevents the native <input type="number"> behavior
        applyBpm(Number(bpmInput.value) + 1);
    } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        applyBpm(Number(bpmInput.value) - 1);
    }
});

// Listens to ticks emitted by the Rust backend
window.__TAURI__.event.listen('metronome-tick', (event) => {
    metronomeLed.classList.add('active');
    setTimeout(() => metronomeLed.classList.remove('active'), 100);
});

// ==========================================
// Synthesizers
// ==========================================
const addSynthBtn   = document.querySelector('#add-synth-btn');
const playAllBtn    = document.querySelector('#play-all-btn');
const synthListBody = document.querySelector('.synth-list-body');
const placeholder   = synthListBody.querySelector('.placeholder-text');

function createSynthElement(id) {
    const el = document.createElement('div');
    el.className = 'synth-block';
    el.dataset.synthId = id;

    // Default color: rotate through the palette
    const defaultColor = SYNTH_COLORS[(synthColors.size) % SYNTH_COLORS.length];
    synthColors.set(id, defaultColor);

    const channelOptions = Array.from({ length: 16 }, (_, i) =>
        `<option value="${i}">${t('synth.channelOption', { number: i + 1 })}</option>`
    ).join('');

    const maxPx = totalPixels > 0 ? totalPixels - 1 : 0;

    const colorSwatches = SYNTH_COLORS.map(c =>
        `<button class="color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`
    ).join('');

    el.innerHTML = `
        <div class="synth-color-band" style="background:${defaultColor}" data-i18n-title="synth.pickColor"></div>
        <div class="synth-color-picker hidden">
            <div class="color-swatches">${colorSwatches}</div>
        </div>
        <div class="synth-header">
            <span class="synth-title-label"></span>
            <button class="synth-remove" data-i18n-title="synth.remove"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>
        </div>
        <div class="synth-body">
            <div class="synth-controls-row">
                <button class="synth-play">
                    <span class="material-symbols-outlined synth-play-icon" aria-hidden="true">play_arrow</span>
                    <span class="synth-play-label"></span>
                </button>
                <button class="synth-loop-btn active" data-i18n-title="synth.toggleLoop">
                    <span class="material-symbols-outlined" aria-hidden="true">repeat</span>
                    <span class="synth-loop-label"></span>
                </button>
                <button class="synth-eye-btn" data-i18n-title="synth.toggleHighlight"><span class="material-symbols-outlined" aria-hidden="true">visibility</span></button>
            </div>
            <label class="synth-channel-label">
                <span data-i18n="synth.channelLabel"></span>
                <select class="synth-channel">${channelOptions}</select>
            </label>

            <div class="synth-mode-row">
                <span data-i18n="synth.modeLabel"></span>
                <div class="synth-mode-buttons">
                    <button class="synth-mode-btn active" data-mode="monophonic"></button>
                    <button class="synth-mode-btn" data-mode="polyphonic"></button>
                </div>
            </div>

            <div class="synth-mode-panel synth-mode-panel-mono">
                <label class="synth-slider-label">
                    <span><span data-i18n="synth.hueShift"></span> <em class="hue-shift-val">0°</em></span>
                    <input type="range" class="slider synth-hue-shift" min="0" max="360" value="0" step="1" />
                </label>
            </div>

            <div class="synth-mode-panel synth-mode-panel-poly hidden">
                <span class="synth-mode-panel-label" data-i18n="synth.channelsPanelLabel"></span>
                <div class="synth-channel-toggles">
                    <button class="synth-channel-toggle active" data-channel="0" data-i18n-title="synth.toggleRed">R</button>
                    <button class="synth-channel-toggle active" data-channel="1" data-i18n-title="synth.toggleGreen">G</button>
                    <button class="synth-channel-toggle active" data-channel="2" data-i18n-title="synth.toggleBlue">B</button>
                </div>
            </div>
            <div class="synth-range-wrapper">
                <div class="synth-range-labels">
                    <span data-i18n="synth.pixelsLabel"></span>
                    <span class="synth-range-values">
                        <em class="range-start-val">0</em> – <em class="range-end-val">${maxPx}</em>
                    </span>
                </div>
                <div class="synth-range-track-row">
                    <div class="synth-range-track">
                        <div class="synth-range-fill"></div>
                        <input type="range" class="synth-range-input range-start" min="0" max="${maxPx}" value="0" step="1" />
                        <input type="range" class="synth-range-input range-end"   min="0" max="${maxPx}" value="${maxPx}" step="1" />
                    </div>
                    <button class="synth-pick-range-btn" data-i18n-title="synth.pickRange">
                        <span class="material-symbols-outlined" aria-hidden="true">crop_free</span>
                    </button>
                </div>
            </div>
            <div class="synth-range-wrapper">
                <div class="synth-range-labels">
                    <span data-i18n="synth.brightnessThreshold"></span>
                    <span class="synth-range-values">
                        <em class="brightness-start-val">0</em> – <em class="brightness-end-val">127</em>
                    </span>
                </div>
                <div class="synth-range-track">
                    <div class="synth-range-fill"></div>
                    <input type="range" class="synth-range-input brightness-start" min="0" max="127" value="0"   step="1" />
                    <input type="range" class="synth-range-input brightness-end"   min="0" max="127" value="127" step="1" />
                </div>
            </div>
            <label class="synth-slider-label">
                <span><span data-i18n="synth.noteThreshold"></span> <em class="threshold-val">0</em></span>
                <input type="range" class="slider synth-threshold" min="0" max="24" value="0" step="1" />
            </label>
            <label class="synth-slider-label">
                <span><span data-i18n="synth.velocityMin"></span> <em class="velocity-min-val">0</em></span>
                <input type="range" class="slider synth-velocity-min" min="0" max="126" value="0" step="1" />
            </label>
            <p class="synth-pixel-info"></p>
        </div>
    `;

    // Translate everything marked with data-i18n* above, plus the elements
    // whose text depends on dynamic state (title, play button, pixel info).
    applyTranslations(el);
    el.querySelector('.synth-title-label').textContent = t('synth.title', { id });
    setPlayButtonState(el.querySelector('.synth-play'), false);
    el.querySelector('.synth-loop-label').textContent = t('synth.loop');
    el.querySelector('.synth-mode-btn[data-mode="monophonic"]').textContent = t('synth.modeMonophonic');
    el.querySelector('.synth-mode-btn[data-mode="polyphonic"]').textContent = t('synth.modePolyphonic');
    el.querySelector('.threshold-val').textContent = t('synth.noteThresholdOff');
    el.querySelector('.synth-pixel-info').textContent = t('synth.pixelInfoEmpty');

    el.querySelector('.synth-play').addEventListener('click', () => onSynthPlayClick(id, el));
    el.querySelector('.synth-remove').addEventListener('click', () => onSynthRemoveClick(id, el));

    // Color band → toggle the picker
    const colorBand   = el.querySelector('.synth-color-band');
    const colorPicker = el.querySelector('.synth-color-picker');
    colorBand.addEventListener('click', () => {
        // Close any other open pickers
        document.querySelectorAll('.synth-color-picker').forEach(p => {
            if (p !== colorPicker) p.classList.add('hidden');
        });
        colorPicker.classList.toggle('hidden');
    });

    // Click on a color
    colorPicker.querySelectorAll('.color-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
            const color = btn.dataset.color;
            synthColors.set(id, color);
            colorBand.style.background = color;
            colorPicker.classList.add('hidden');
            // Redraw the highlight with the new color
            redrawAllHighlights();
        });
    });

    // Close the picker when clicking elsewhere
    document.addEventListener('click', (e) => {
        if (!el.contains(e.target)) colorPicker.classList.add('hidden');
    });
    el.querySelector('.synth-channel').addEventListener('change', (e) => {
        invoke('set_synth_channel', { id, channel: Number(e.target.value) })
            .catch(err => console.error('Error in set_synth_channel:', err));
    });

    el.querySelector('.synth-loop-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const loopEnabled = !btn.classList.contains('active');
        btn.classList.toggle('active', loopEnabled);
        invoke('set_synth_loop', { id, loopEnabled })
            .catch(err => console.error('Error in set_synth_loop:', err));
    });

    // ---- Monophonic / polyphonic mode ----
    const modeBtns  = el.querySelectorAll('.synth-mode-btn');
    const monoPanel = el.querySelector('.synth-mode-panel-mono');
    const polyPanel = el.querySelector('.synth-mode-panel-poly');

    modeBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            const newMode = btn.dataset.mode;
            if (btn.classList.contains('active')) return; // already the active mode
            try {
                await invoke('set_synth_mode', { id, mode: newMode });
                modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === newMode));
                monoPanel.classList.toggle('hidden', newMode !== 'monophonic');
                polyPanel.classList.toggle('hidden', newMode !== 'polyphonic');
            } catch (err) {
                console.error('Error in set_synth_mode:', err);
            }
        });
    });

    // ---- Hue shift (monophonic mode) ----
    const hueShiftInput = el.querySelector('.synth-hue-shift');
    const hueShiftVal    = el.querySelector('.hue-shift-val');
    hueShiftInput.addEventListener('input', () => {
        const hueShift = Number(hueShiftInput.value);
        hueShiftVal.textContent = `${hueShift}°`;
        invoke('set_synth_hue_shift', { id, hueShift })
            .catch(err => console.error('Error in set_synth_hue_shift:', err));
    });

    // ---- R/G/B channel toggles (polyphonic mode) ----
    el.querySelectorAll('.synth-channel-toggle').forEach(toggleBtn => {
        toggleBtn.addEventListener('click', () => {
            const channelIndex = Number(toggleBtn.dataset.channel);
            const enabled = !toggleBtn.classList.contains('active');
            toggleBtn.classList.toggle('active', enabled);
            invoke('set_synth_channel_enabled', { id, channelIndex, enabled })
                .catch(err => console.error('Error in set_synth_channel_enabled:', err));
        });

        // Visual preview of the hovered channel, overlaid on the image
        toggleBtn.addEventListener('mouseenter', () => {
            const channelIndex = Number(toggleBtn.dataset.channel);
            drawChannelOverlay(channelIndex);
        });
        toggleBtn.addEventListener('mouseleave', () => {
            hideChannelOverlay();
        });
    });

    // Initialize the highlight state (hidden by default)
    synthHighlights.set(id, { visible: false, start: 0, end: maxPx });

    // Eye button
    el.querySelector('.synth-eye-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const hi = synthHighlights.get(id);
        hi.visible = !hi.visible;
        btn.classList.toggle('active', hi.visible);
        if (hi.visible) drawRangeHighlight(id);
        else            clearRangeHighlight(id);
    });

    // Note change threshold slider
    const thresholdInput = el.querySelector('.synth-threshold');
    const thresholdVal   = el.querySelector('.threshold-val');
    thresholdInput.addEventListener('input', () => {
        const threshold = Number(thresholdInput.value);
        thresholdVal.textContent = threshold === 0 ? t('synth.noteThresholdOff') : threshold;
        invoke('set_synth_threshold', { id, threshold })
            .catch(err => console.error('Error in set_synth_threshold:', err));
    });

    // Minimum velocity slider: floor of the velocity range (brightness is
    // mapped between this value and 127)
    const velocityMinInput = el.querySelector('.synth-velocity-min');
    const velocityMinVal   = el.querySelector('.velocity-min-val');
    velocityMinInput.addEventListener('input', () => {
        const velocityMin = Number(velocityMinInput.value);
        velocityMinVal.textContent = velocityMin;
        invoke('set_synth_velocity_min', { id, velocityMin })
            .catch(err => console.error('Error in set_synth_velocity_min:', err));
    });

    // Range selection button on the image
    el.querySelector('.synth-pick-range-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (rangePickState && rangePickState.id === id) {
            cancelRangePicking();
        } else {
            startRangePicking(id, btn);
        }
    });

    initSynthRange(id, el);
    initBrightnessRange(id, el);

    return el;
}

function initSynthRange(id, el) {
    const startInput = el.querySelector('.range-start');
    const endInput   = el.querySelector('.range-end');
    const startVal   = el.querySelector('.range-start-val');
    const endVal     = el.querySelector('.range-end-val');
    const fill       = el.querySelector('.synth-range-fill');

    function updateFill() {
        const max = Number(startInput.max) || 1;
        const s = Number(startInput.value) / max * 100;
        const e = Number(endInput.value)   / max * 100;
        fill.style.left  = `${s}%`;
        fill.style.width = `${e - s}%`;

        // The left thumb must always stay clickable: bring it to the front
        // when it is close to or equal to the right thumb
        const atEnd = Number(startInput.value) >= Number(endInput.value);
        startInput.style.zIndex = atEnd ? '3' : '2';
        endInput.style.zIndex   = atEnd ? '1' : '2';
    }

    function sendRange() {
        const pixelStart = Number(startInput.value);
        const pixelEnd   = Number(endInput.value);
        invoke('set_synth_range', { id, pixelStart, pixelEnd })
            .catch(err => console.error('Error in set_synth_range:', err));
        // Update the highlight if visible
        const hi = synthHighlights.get(id);
        if (hi) { hi.start = pixelStart; hi.end = pixelEnd; }
        redrawAllHighlights();
    }

    startInput.addEventListener('input', () => {
        if (Number(startInput.value) > Number(endInput.value)) {
            startInput.value = endInput.value;
        }
        startVal.textContent = startInput.value;
        updateFill();
        sendRange();
    });

    endInput.addEventListener('input', () => {
        if (Number(endInput.value) < Number(startInput.value)) {
            endInput.value = startInput.value;
        }
        endVal.textContent = endInput.value;
        updateFill();
        sendRange();
    });

    updateFill();
}

function initBrightnessRange(id, el) {
    const startInput = el.querySelector('.brightness-start');
    const endInput   = el.querySelector('.brightness-end');
    const startVal   = el.querySelector('.brightness-start-val');
    const endVal     = el.querySelector('.brightness-end-val');
    const fill       = startInput.closest('.synth-range-track').querySelector('.synth-range-fill');

    function updateFill() {
        const max = 127;
        const s = Number(startInput.value) / max * 100;
        const e = Number(endInput.value)   / max * 100;
        fill.style.left  = `${s}%`;
        fill.style.width = `${e - s}%`;

        const atEnd = Number(startInput.value) >= Number(endInput.value);
        startInput.style.zIndex = atEnd ? '3' : '2';
        endInput.style.zIndex   = atEnd ? '1' : '2';
    }

    function sendRange() {
        invoke('set_synth_brightness_range', {
            id,
            brightnessMin: Number(startInput.value),
            brightnessMax: Number(endInput.value),
        }).catch(err => console.error('Error in set_synth_brightness_range:', err));
    }

    startInput.addEventListener('input', () => {
        if (Number(startInput.value) > Number(endInput.value)) startInput.value = endInput.value;
        startVal.textContent = startInput.value;
        updateFill();
        sendRange();
    });

    endInput.addEventListener('input', () => {
        if (Number(endInput.value) < Number(startInput.value)) endInput.value = startInput.value;
        endVal.textContent = endInput.value;
        updateFill();
        sendRange();
    });

    updateFill();
}

function updateAllSynthRangeMax(newTotal) {
    const maxPx = newTotal > 0 ? newTotal - 1 : 0;
    synthListBody.querySelectorAll('.synth-block').forEach(el => {
        const startInput = el.querySelector('.range-start');
        const endInput   = el.querySelector('.range-end');
        const endVal     = el.querySelector('.range-end-val');

        startInput.max = maxPx;
        endInput.max   = maxPx;

        // Reclamp the values if they exceed the new max
        if (Number(startInput.value) > maxPx) startInput.value = maxPx;
        if (Number(endInput.value)   > maxPx || Number(endInput.value) === 0) endInput.value = maxPx;

        endVal.textContent = endInput.value;
        el.querySelector('.synth-range-fill') && initFillUpdate(el);

        // Recalibrate the highlight bounds
        const synthId = Number(el.dataset.synthId);
        const hi = synthHighlights.get(synthId);
        if (hi) { hi.start = Number(el.querySelector('.range-start').value); hi.end = Number(endInput.value); }
    });
    redrawAllHighlights();
}

function initFillUpdate(el) {
    const startInput = el.querySelector('.range-start');
    const endInput   = el.querySelector('.range-end');
    const fill       = el.querySelector('.synth-range-fill');
    const max = Number(startInput.max) || 1;
    const s = Number(startInput.value) / max * 100;
    const e = Number(endInput.value)   / max * 100;
    fill.style.left  = `${s}%`;
    fill.style.width = `${e - s}%`;
}

async function onSynthPlayClick(id, el) {
    const isPlaying = await invoke('is_synth_playing', { id });
    if (!isPlaying) {
        await startSynthPlayback(id, el);
    } else {
        await stopSynthPlayback(id, el);
    }
    syncPlayAllButton();
}

// Updates the "play all" button's label based on the synths' current state
function syncPlayAllButton() {
    const blocks = Array.from(synthListBody.querySelectorAll('.synth-block'));
    const anyPlaying = blocks.some(el => el.querySelector('.synth-play').classList.contains('active'));
    playAllBtn.querySelector('.material-symbols-outlined').textContent = anyPlaying ? 'pause' : 'play_arrow';
    playAllBtn.title = anyPlaying
        ? t('synthList.playAllStop')
        : t('synthList.playAllStart');
}

// Locks/unlocks the controls specific to a synth while it is playing
// (MIDI channel, mono/poly mode, and the pixel range). Everything else
// (hue shift, R/G/B toggles, thresholds, velocity, loop, highlight...)
// remains editable on the fly while the synth is playing.
function setSynthControlsLocked(el, locked) {
    el.querySelector('.synth-channel').disabled = locked;
    el.querySelectorAll('.synth-mode-btn').forEach(btn => { btn.disabled = locked; });
    el.querySelector('.range-start').disabled = locked;
    el.querySelector('.range-end').disabled = locked;
    el.querySelector('.synth-pick-range-btn').disabled = locked;

    // If this synth was mid-selection when it started playing, cancel it.
    const id = Number(el.dataset.synthId);
    if (locked && rangePickState && rangePickState.id === id) {
        cancelRangePicking();
    }
}

async function startSynthPlayback(id, el) {
    const btn = el.querySelector('.synth-play');
    await ensureMetronomeStarted();
    await invoke('start_synth', { id });
    setPlayButtonState(btn, true);
    // Hide the highlight during playback
    hideHighlightForPlay(id);
    // Lock this synth's controls while it is playing
    setSynthControlsLocked(el, true);
    updateImageControlsLockState();
}

async function stopSynthPlayback(id, el) {
    const btn = el.querySelector('.synth-play');
    await invoke('stop_synth', { id });
    setPlayButtonState(btn, false);
    // Show the highlight again if the eye button is active
    restoreHighlightAfterStop(id, el);
    await stopMetronomeIfIdle();
    // Unlock this synth's controls
    setSynthControlsLocked(el, false);
    updateImageControlsLockState();
}

function hideHighlightForPlay(id) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    hi._wasVisible = hi.visible; // remember the state
    if (hi.visible) {
        hi.visible = false;
        redrawAllHighlights();
    }
}

function restoreHighlightAfterStop(id, el) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    if (hi._wasVisible) {
        hi.visible = true;
        hi._wasVisible = false;
        redrawAllHighlights();
    }
    // Clear this synth's cursor from the canvas
    synthCursors.delete(id);
    redrawAllHighlights();
}

async function onSynthRemoveClick(id, el) {
    await invoke('stop_synth', { id }).catch(() => {});
    await invoke('remove_synth', { id });

    if (rangePickState && rangePickState.id === id) cancelRangePicking();

    synthColors.delete(id);
    synthCursors.delete(id);
    synthHighlights.delete(id);
    el.remove();
    redrawAllHighlights();

    if (synthListBody.querySelectorAll('.synth-block').length === 0) {
        placeholder.classList.remove('hidden');
    }
    syncPlayAllButton();
    await stopMetronomeIfIdle();
    updateImageControlsLockState();
}

addSynthBtn.addEventListener('click', async () => {
    try {
        const id = await invoke('add_synth');
        placeholder.classList.add('hidden');
        synthListBody.appendChild(createSynthElement(id));
    } catch (err) {
        console.error('Error while adding the synthesizer:', err);
        alert(translateError(err)); // or a more discreet display like a toast/error message in the UI
    }
});

// ---------- Start/stop all synthesizers ----------
playAllBtn.addEventListener('click', async () => {
    const blocks = Array.from(synthListBody.querySelectorAll('.synth-block'));
    if (blocks.length === 0) return;

    // We consider the whole set "playing" if at least one synth is already playing.
    const anyPlaying = blocks.some(el => el.querySelector('.synth-play').classList.contains('active'));

    if (anyPlaying) {
        // Stop everything
        for (const el of blocks) {
            const id = Number(el.dataset.synthId);
            if (el.querySelector('.synth-play').classList.contains('active')) {
                await stopSynthPlayback(id, el);
            }
        }
    } else {
        // Start everything
        for (const el of blocks) {
            const id = Number(el.dataset.synthId);
            await startSynthPlayback(id, el);
        }
    }
    syncPlayAllButton();
});

// Automatic stop at the end of the sequence (non-loop mode)
window.__TAURI__.event.listen('synth-stopped', async (event) => {
    const { id } = event.payload;
    const el = synthListBody.querySelector(`[data-synth-id="${id}"]`);
    if (!el) return;
    const btn = el.querySelector('.synth-play');
    setPlayButtonState(btn, false);
    synthCursors.delete(id);
    restoreHighlightAfterStop(id, el);
    syncPlayAllButton();
    await stopMetronomeIfIdle();
    // Unlock this synth's controls
    setSynthControlsLocked(el, false);
    updateImageControlsLockState();
});

// Receiving pixel ticks, one per synth
window.__TAURI__.event.listen('synth-pixel-tick', (event) => {
    const { id, cursor, r, g, b, a, velocity, muted, mode, note, voices } = event.payload;
    const el = synthListBody.querySelector(`[data-synth-id="${id}"]`);
    if (!el) return;

    const rgbaStr = `rgba(${r ?? '-'}, ${g ?? '-'}, ${b ?? '-'}, ${a ?? '-'})`;
    let noteInfo;

    if (mode === 'polyphonic' && Array.isArray(voices)) {
        const labels = ['R', 'G', 'B'];
        noteInfo = voices.map((v, i) => {
            if (!v.enabled) return t('synth.voiceOff', { channel: labels[i] });
            const name = midiNoteToName(v.note);
            return v.muted
                ? t('synth.voiceMuted', { channel: labels[i], note: name })
                : `${labels[i]}:${name}`;
        }).join('  ');
    } else {
        const noteName = midiNoteToName(note);
        noteInfo = t('synth.noteLabel', { note: noteName }) + (muted ? t('synth.noteMuted') : '');
    }

    const pixelInfoEl = el.querySelector('.synth-pixel-info');
    pixelInfoEl.textContent = t('synth.pixelInfo', { cursor, rgba: rgbaStr, noteInfo, velocity: velocity ?? '-' });
    pixelInfoEl.dataset.hasTick = '1';
    drawSynthPixel(id, cursor, muted);
});

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiNoteToName(midi) {
    if (midi == null) return '-';
    const octave = Math.floor(midi / 12) - 1;
    const name = NOTE_NAMES[midi % 12];
    return `${name}${octave} (${midi})`;
}