import { initI18n, t, translateError, getLocale, setLocale, AVAILABLE_LOCALES, applyTranslations } from './i18n.js';

const { invoke } = window.__TAURI__.core;

await initI18n();

// Map id → custom name
const synthNames = new Map();

// Display name of a synth: its custom name, or the translated default
function synthDisplayName(id) {
    return synthNames.get(id) || t('synth.title', { id });
}

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
// the few labels whose text depends on dynamic state (play/stop, mode)
// that data-i18n alone can't express.
function retranslateSynthElement(el) {
    applyTranslations(el);

    const id = Number(el.dataset.synthId);
    el.querySelector('.synth-title-label').textContent = synthDisplayName(id);

    const playBtn = el.querySelector('.synth-play');
    setPlayButtonState(playBtn, playBtn.classList.contains('active'));

    el.querySelector('.synth-mode-btn[data-mode="monophonic"]').textContent = t('synth.modeMonophonic');
    el.querySelector('.synth-mode-btn[data-mode="polyphonic"]').textContent = t('synth.modePolyphonic');

    // Pixel info: only reset to the empty placeholder if no tick has been
    // received yet (i.e. it still shows the untranslated empty state).
    const pixelInfo = el.querySelector('.synth-pixel-info');
    if (!pixelInfo.dataset.hasTick) {
        pixelInfo.textContent = t('synth.pixelInfoEmpty');
    }

    const directionBtn = el.querySelector('.synth-reading-direction-btn');
    if (directionBtn) updateReadingDirectionBtn(directionBtn);

    updateZonesLabel(Number(el.dataset.synthId));
}

// ---------- Global configuration ----------
// The BPM input is initialized with the persisted default; the config
// file itself is hand-edited via the gear button in the footer (edits
// apply on the next application start).
invoke('get_config').then(config => {
    bpmInput.value = config.default_bpm;
}).catch(err => console.error('Error in get_config:', err));

document.querySelector('#open-config-btn').addEventListener('click', () => {
    invoke('open_config_file')
        .catch(err => console.error('Error in open_config_file:', err));
});

// Re-apply translations everywhere (static markup + dynamically created
// synth cards) whenever the locale changes.
window.addEventListener('locale-changed', () => {
    renderLanguageSwitcher();
    document.querySelectorAll('.synth-block').forEach(el => retranslateSynthElement(el));
    if (typeof syncLabels === 'function') syncLabels();
    if (lastDimensionsInfo) dimensionsInfo.textContent = t('controls.dimensionsInfo', lastDimensionsInfo);
    if (typeof syncPlayAllButton === 'function') syncPlayAllButton();
});

// Icon and localized title of each reading direction, applied to the
// cycling button of a synth.
const READING_DIRECTION_ICONS = {
    leftToRight: 'arrow_forward',
    rightToLeft: 'arrow_back',
    topToBottom: 'arrow_downward',
    bottomToTop: 'arrow_upward',
};
function updateReadingDirectionBtn(btn) {
    const direction = btn.dataset.direction || 'leftToRight';
    btn.querySelector('.material-symbols-outlined').textContent =
        READING_DIRECTION_ICONS[direction];
    btn.title = t(`synth.readingDirection.${direction}`);
}

// ---------- Elements ----------
const loadBtn         = document.querySelector('#load-btn');
const resetBtn        = document.querySelector('#reset-btn');
const showOriginal    = document.querySelector('#show-original');
const preview         = document.querySelector('#preview');
const viewerEmpty     = document.querySelector('#viewer-empty');
const pixelOverlay    = document.querySelector('#pixel-overlay');

const gridSlider      = document.querySelector('#grid-width');
const gridValue       = document.querySelector('#grid-width-value');

const saturation      = document.querySelector('#saturation');
const saturationValue = document.querySelector('#saturation-value');
const contrast        = document.querySelector('#contrast');
const contrastValue   = document.querySelector('#contrast-value');
const brightness      = document.querySelector('#brightness');
const brightnessValue = document.querySelector('#brightness-value');
const posterize       = document.querySelector('#posterize');
const posterizeValue  = document.querySelector('#posterize-value');

const dimensionsInfo  = document.querySelector('#dimensions-info');

// Image controls to lock while a synthesizer is playing
// (the "Show original" button is intentionally excluded)
const imageLockControls = [loadBtn, resetBtn, gridSlider, contrast, brightness, saturation, posterize];

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

// ---------- Mouse-based rectangular zone selection ----------
// Only one synth can be in zone-drawing mode at a time. While the mode is
// active, each rectangle dragged on the image either adds a zone (drag
// starting on a free pixel) or removes pixels from the existing zones
// (drag starting on an already-selected pixel).
let zonePickState = null; // { id, btn } while the drawing mode is armed
let zoneDrag = null;      // { id, start, cur, mode: 'add'|'remove' } while dragging

// A pixel is "selected" if it is covered by one of the synth's explicit
// zones. With no zone defined yet, the whole image is the default selection
// but the first drag always creates a zone (rather than removing from the
// implicit whole-image selection).
function isPixelSelected(id, col, row) {
    const hi = synthHighlights.get(id);
    if (!hi) return false;
    if (hi.zones.length === 0) return false;
    return hi.zones.some(z =>
        col >= z.x && col < z.x + z.w &&
        row >= z.y && row < z.y + z.h
    );
}

function cellFromClientPoint(clientX, clientY) {
    const layout = getImageLayout();
    if (!layout) return null;
    const rect = pixelOverlay.getBoundingClientRect();
    const col = Math.floor((clientX - rect.left - layout.offsetX) / layout.cellW);
    const row = Math.floor((clientY - rect.top - layout.offsetY) / layout.cellH);
    if (col < 0 || row < 0 || col >= gridW || row >= gridH) return null;
    return { col, row };
}

function startZonePicking(id, btn) {
    // Cancel any drawing mode already active on another synth
    if (zonePickState && zonePickState.id !== id) {
        cancelZonePicking();
    }
    zonePickState = { id, btn };
    btn.classList.add('active');
    pixelOverlay.classList.add('picking');
}

function cancelZonePicking() {
    if (!zonePickState) return;
    zonePickState.btn.classList.remove('active');
    pixelOverlay.classList.remove('picking');
    zonePickState = null;
    if (zoneDrag) {
        zoneDrag = null;
        redrawAllHighlights();
    }
}

window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelZonePicking();
});

pixelOverlay.addEventListener('mousedown', (e) => {
    if (!zonePickState || !hasImage) return;
    const cell = cellFromClientPoint(e.clientX, e.clientY);
    if (!cell) return;
    e.preventDefault(); // prevents image dragging during selection
    const mode = isPixelSelected(zonePickState.id, cell.col, cell.row)
        ? 'remove'
        : 'add';
    zoneDrag = { id: zonePickState.id, start: cell, cur: cell, mode };
});

pixelOverlay.addEventListener('mousemove', (e) => {
    if (!zoneDrag) return;
    const cell = cellFromClientPoint(e.clientX, e.clientY);
    if (!cell) return;
    zoneDrag.cur = cell;
    redrawAllHighlights();
    drawZonePreview();
});

window.addEventListener('mouseup', (e) => {
    if (!zoneDrag) return;
    const { id, start, cur, mode } = zoneDrag;
    zoneDrag = null;
    const moved = start.col !== cur.col || start.row !== cur.row;
    if (moved) {
        const rect = {
            x: Math.min(start.col, cur.col),
            y: Math.min(start.row, cur.row),
            w: Math.abs(cur.col - start.col) + 1,
            h: Math.abs(cur.row - start.row) + 1,
        };
        if (mode === 'add') addSynthZone(id, rect);
        else                removeSynthZoneRect(id, rect);
    }
    redrawAllHighlights();
});

// Live preview of the rectangle being dragged: filled with the synth's
// color in add mode, "erasing" the highlights beneath it in remove mode.
function drawZonePreview() {
    if (!zoneDrag) return;
    const layout = getImageLayout();
    if (!layout) return;
    const { offsetX, offsetY, cellW, cellH } = layout;
    const { start, cur } = zoneDrag;
    const x = Math.min(start.col, cur.col);
    const y = Math.min(start.row, cur.row);
    const w = Math.abs(cur.col - start.col) + 1;
    const h = Math.abs(cur.row - start.row) + 1;

    const ctx = pixelOverlay.getContext('2d');
    ctx.save();
    if (zoneDrag.mode === 'remove') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillRect(offsetX + x * cellW, offsetY + y * cellH, w * cellW, h * cellH);
    } else {
        ctx.fillStyle = synthColors.get(zoneDrag.id) || '#ffffff';
        ctx.globalAlpha = 0.4;
        ctx.fillRect(offsetX + x * cellW, offsetY + y * cellH, w * cellW, h * cellH);
    }
    ctx.restore();
}

function addSynthZone(id, zone) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    hi.zones.push(zone);
    sendSynthZones(id);
    updateZonesLabel(id);
}

// Subtracts a rectangle from the synth's zones. Sub-zones that end up empty
// are dropped; a zone split by the rectangle is cut into up to 4 bands.
// With no zone defined (whole image selected), the whole image is first
// materialized as a single zone so the subtraction has something to bite.
function removeSynthZoneRect(id, rect) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    if (hi.zones.length === 0) {
        hi.zones = [{ x: 0, y: 0, w: gridW, h: gridH }];
    }
    const next = [];
    for (const z of hi.zones) {
        for (const r of subtractRect(z, rect)) next.push(r);
    }
    hi.zones = next;
    sendSynthZones(id);
    updateZonesLabel(id);
}

// Computes zone `z` minus rectangle `r`: returns the 0–4 remaining
// rectangles (top band, bottom band, left band, right band).
function subtractRect(z, r) {
    // Intersection bounds; no overlap → the zone is kept intact
    const x1 = Math.max(z.x, r.x);
    const y1 = Math.max(z.y, r.y);
    const x2 = Math.min(z.x + z.w, r.x + r.w);
    const y2 = Math.min(z.y + z.h, r.y + r.h);
    if (x1 >= x2 || y1 >= y2) return [z];

    const result = [];
    if (z.y < y1) result.push({ x: z.x, y: z.y, w: z.w, h: y1 - z.y });
    if (y2 < z.y + z.h) result.push({ x: z.x, y: y2, w: z.w, h: (z.y + z.h) - y2 });
    if (z.x < x1) result.push({ x: z.x, y: y1, w: x1 - z.x, h: y2 - y1 });
    if (x2 < z.x + z.w) result.push({ x: x2, y: y1, w: (z.x + z.w) - x2, h: y2 - y1 });
    return result;
}

function sendSynthZones(id) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    invoke('set_synth_zones', { id, zones: hi.zones })
        .catch(err => console.error('Error in set_synth_zones:', err));
}

// Sends the note-range filter states: one triplet (bass, medium, treble)
// for the monophonic note, and one per R/G/B voice in polyphonic mode.
function sendSynthNoteRanges(id, el) {
    const read = group => ['bass', 'medium', 'treble'].map(kind =>
        group.querySelector(`.synth-${kind}`).classList.contains('active')
    );
    const mono = read(el.querySelector('.synth-mode-panel-mono .synth-note-range'));
    const voices = Array.from(el.querySelectorAll('.synth-mode-panel-poly .synth-note-range'))
        .map(read);
    invoke('set_synth_note_ranges', { id, mono, voices })
        .catch(err => console.error('Error in set_synth_note_ranges:', err));
}
// Sends the enabled note lengths ("whole", "half", "quarter", "eighth",
// "sixteenth"). The UI always keeps at least one button active.
function sendSynthNoteLengths(id, el) {
    const lengths = Array.from(el.querySelectorAll('.note-length-btn.active'))
        .map(btn => btn.dataset.length);
    invoke('set_synth_note_lengths', { id, lengths })
        .catch(err => console.error('Error in set_synth_note_lengths:', err));
}

// Number of pixels a synth will play: the sum of its zone areas (clipped
// to the grid), or the whole image when no zone is defined. Overlapping
// zones are counted twice, mirroring the backend's playback sequence.
function synthSequenceLength(id) {
    const hi = synthHighlights.get(id);
    if (!hi) return 0;
    if (hi.zones.length === 0) return gridW * gridH;
    let total = 0;
    for (const z of hi.zones) {
        const w = Math.min(z.w, gridW - z.x);
        const h = Math.min(z.h, gridH - z.y);
        if (w > 0 && h > 0) total += w * h;
    }
    return total;
}

// Compact duration: seconds below one minute, m:ss below one hour
function formatDuration(seconds) {
    if (seconds < 60) {
        return `${Math.round(seconds * 10) / 10} s`;
    }
    const total = Math.round(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// "zones-val" shows the number of selected pixels and, in parentheses,
// the total playing time at the synth's own tempo (metronome BPM scaled
// by its tempo ratio).
function updateZonesLabel(id) {
    const el = synthListBody.querySelector(`[data-synth-id="${id}"]`);
    if (!el) return;
    const zonesVal = el.querySelector('.zones-val');

    if (!hasImage) {
        zonesVal.textContent = '-';
        return;
    }

    const pixelCount = synthSequenceLength(id);
    const tempoRatio = Number(el.querySelector('.synth-tempo').value) || 1;
    const bpm = clampBpm(Number(bpmInput.value));
    const seconds = pixelCount * (60 / bpm) / tempoRatio;

    zonesVal.textContent = `${pixelCount} px (${formatDuration(seconds)})`;
}

function updateAllSynthZonesLabels() {
    synthListBody.querySelectorAll('.synth-block').forEach(el => {
        updateZonesLabel(Number(el.dataset.synthId));
    });
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

    // No zone = the whole image is selected
    const zones = hi.zones.length > 0 ? hi.zones : [{ x: 0, y: 0, w: gridW, h: gridH }];

    const ctx = pixelOverlay.getContext('2d');
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle   = color;
    for (const z of zones) {
        ctx.fillRect(offsetX + z.x * cellW, offsetY + z.y * cellH, z.w * cellW, z.h * cellH);
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
    saturation:       Number(saturation.value),
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
  saturationValue.textContent = Number(saturation.value).toFixed(0);

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
    cancelZonePicking();
    updateAllSynthZones();
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
  contrast.value    = 0;
  brightness.value  = 0;
  saturation.value  = 0;
  posterize.value   = 1;

  syncLabels();
  refresh();
});

// ---------- Session save / load ----------
const saveSessionBtn = document.querySelector('#save-session-btn');
const loadSessionBtn = document.querySelector('#load-session-btn');

// Collects the frontend-owned state (metronome tempo, image sliders, synth
// colors in display order); the backend owns the rest (image, synths).
saveSessionBtn.addEventListener('click', async () => {
    const levels = Number(posterize.value);
    const ui = {
        bpm: clampBpm(Number(bpmInput.value)),
        grid_slider: Number(gridSlider.value),
        contrast: Number(contrast.value),
        brightness: Number(brightness.value),
        saturation: Number(saturation.value),
        posterize_levels: levels > 1 ? levels : null,
        synth_colors: Array.from(synthListBody.querySelectorAll('.synth-block')).map(el => ({
            id: Number(el.dataset.synthId),
            color: synthColors.get(Number(el.dataset.synthId)),
        })),
    };
    try {
        await invoke('save_session', { ui });
    } catch (err) {
        console.error('Error while saving the session:', err);
        alert(translateError(err));
    }
});

loadSessionBtn.addEventListener('click', async () => {
    let session;
    try {
        session = await invoke('load_session');
    } catch (err) {
        console.error('Error while loading the session:', err);
        alert(translateError(err));
        return;
    }
    if (!session) return; // dialog canceled

    // Stop everything and clear the current synths
    await invoke('stop_metronome');
    metronomeRunning = false;
    synthListBody.querySelectorAll('.synth-block').forEach(el => el.remove());
    synthColors.clear();
    synthCursors.clear();
    synthHighlights.clear();
    synthNames.clear();
    placeholder.classList.remove('hidden');
    cancelZonePicking();
    syncPlayAllButton();
    updateImageControlsLockState();

    // Restore the image and its processing settings (the backend already
    // holds the original: refresh re-derives the processed grid)
    origWidth = session.orig_width;
    origHeight = session.orig_height;
    originalPng = session.image_base64;
    hasImage = true;
    gridSlider.value = session.image_settings.grid_slider;
    contrast.value = session.image_settings.contrast;
    brightness.value = session.image_settings.brightness;
    saturation.value = session.image_settings.saturation;
    posterize.value = session.image_settings.posterize_levels ?? 1;
    showOriginal.checked = false;
    viewerEmpty.classList.add('hidden');
    preview.classList.remove('hidden');
    syncLabels();
    await refresh();

    // Restore the tempo and the synths
    bpmInput.value = clampBpm(session.bpm);
    if (session.synths.length > 0) {
        placeholder.classList.add('hidden');
        for (const s of session.synths) {
            // Pre-seed the name and color for createSynthElement to pick up
            synthColors.set(s.id, s.color);
            if (s.name) synthNames.set(s.id, s.name);
            // The synth settings are flattened into the session-synth object
            // (serde flatten), so `s` itself is the config to apply
            synthListBody.appendChild(createSynthElement(s.id, s));
            const hi = synthHighlights.get(s.id);
            if (hi) hi.zones = s.zones || [];
            updateZonesLabel(s.id);
        }
        redrawAllHighlights();
    }
});

// ---------- Listeners ----------
[gridSlider, contrast, brightness, saturation, posterize].forEach(el => {
  el.addEventListener('input', () => {
    syncLabels();
    scheduleRefresh();
  });
});

showOriginal.addEventListener('change', updatePreviewSrc);

// ---------- Init ----------
syncLabels();

// ---------- Metronome ----------
const bpmInput = document.querySelector('#bpm-input');
const bpmMinus10 = document.querySelector('#bpm-minus10');
const bpmMinus5  = document.querySelector('#bpm-minus5');
const bpmPlus5   = document.querySelector('#bpm-plus5');
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
    updateAllSynthZonesLabels();
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
bpmMinus5.addEventListener('click',  () => applyBpm(Number(bpmInput.value) - 5));
bpmPlus5.addEventListener('click',   () => applyBpm(Number(bpmInput.value) + 5));
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

// Reflects a newly created synth's backend state (built from the
// default-synth template) into its UI. No backend calls needed: the state
// is already applied server-side.
function applySynthConfig(el, cfg) {
    // Tempo
    el.querySelector('.synth-tempo').value = String(cfg.tempo_ratio);
    // MIDI channel
    el.querySelector('.synth-channel').value = String(cfg.channel);
    // Mode (monophonic / polyphonic)
    const mode = cfg.mode === 'polyphonic' ? 'polyphonic' : 'monophonic';
    el.querySelectorAll('.synth-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === mode);
    });
    el.querySelector('.synth-mode-panel-mono').classList.toggle('hidden', mode !== 'monophonic');
    el.querySelector('.synth-mode-panel-poly').classList.toggle('hidden', mode !== 'polyphonic');
    // Loop / back-and-forth (mutually exclusive)
    el.querySelector('.synth-loop-btn').classList.toggle('active', !!cfg.loop_enabled && !cfg.back_and_forth);
    el.querySelector('.synth-back-n-forth-btn').classList.toggle('active', !!cfg.back_and_forth);
    // Reading direction
    const dirBtn = el.querySelector('.synth-reading-direction-btn');
    dirBtn.dataset.direction = cfg.reading_direction || 'leftToRight';
    updateReadingDirectionBtn(dirBtn);
    // Brightness threshold
    el.querySelector('.brightness-start').value = cfg.brightness_min;
    el.querySelector('.brightness-end').value = cfg.brightness_max;
    el.querySelector('.brightness-start-val').textContent = cfg.brightness_min;
    el.querySelector('.brightness-end-val').textContent = cfg.brightness_max;
    // Minimum velocity
    el.querySelector('.synth-velocity-min').value = cfg.velocity_min;
    el.querySelector('.velocity-min-val').textContent = cfg.velocity_min;
    // Hue shift (monophonic panel)
    el.querySelector('.synth-hue-shift').value = cfg.hue_shift;
    el.querySelector('.hue-shift-val').textContent = `${cfg.hue_shift}°`;
    // R/G/B channel toggles (polyphonic panel)
    el.querySelectorAll('.synth-channel-toggle').forEach(btn => {
        const i = Number(btn.dataset.channel);
        btn.classList.toggle('active', !cfg.channel_enabled || !!cfg.channel_enabled[i]);
    });
    // Note lengths (guarantee at least one active)
    const lengths = Array.isArray(cfg.note_lengths) && cfg.note_lengths.length > 0
        ? cfg.note_lengths
        : ['quarter'];
    el.querySelectorAll('.note-length-btn').forEach(btn => {
        btn.classList.toggle('active', lengths.includes(btn.dataset.length));
    });
    el.querySelector('.synth-reverse-note-length').classList.toggle('active', !!cfg.note_length_reversed);
    // Note ranges (mono + one per voice)
    const setRange = (group, toggles) => ['bass', 'medium', 'treble'].forEach((kind, i) => {
        group.querySelector(`.synth-${kind}`).classList.toggle('active', !!(toggles && toggles[i]));
    });
    setRange(el.querySelector('.synth-mode-panel-mono .synth-note-range'), cfg.mono_note_range);
    el.querySelectorAll('.synth-mode-panel-poly .synth-note-range').forEach((group, i) => {
        setRange(group, cfg.voice_note_ranges && cfg.voice_note_ranges[i]);
    });
}

function createSynthElement(id, cfg = null) {
    const el = document.createElement('div');
    el.className = 'synth-block';
    el.dataset.synthId = id;

    // Color: reuse a pre-seeded entry (session load), or rotate through
    // the palette
    const seededColor = synthColors.get(id);
    const defaultColor = seededColor || SYNTH_COLORS[(synthColors.size) % SYNTH_COLORS.length];
    synthColors.set(id, defaultColor);

    const channelOptions = Array.from({ length: 16 }, (_, i) =>
        `<option value="${i}">${t('synth.channelOption', { number: i + 1 })}</option>`
    ).join('');

    const colorSwatches = SYNTH_COLORS.map(c =>
        `<button class="color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`
    ).join('');

    el.innerHTML = `
        <div class="synth-color-band" style="background:${defaultColor}" data-i18n-title="synth.pickColor"></div>
        <div class="synth-color-picker hidden">
            <div class="color-swatches">${colorSwatches}</div>
        </div>
        <div class="synth-header">
            <div class="synth-header-row">
                <span class="synth-title-label" data-i18n-title="synth.renameHint"></span>
                <div class="flex-filler"></div>
                <button class="synth-save-template" data-i18n-title="synth.saveAsTemplate">
                    <span class="material-symbols-outlined" aria-hidden="true">bookmark_add</span>
                </button>
                <button class="synth-remove" data-i18n-title="synth.remove">
                    <span class="material-symbols-outlined" aria-hidden="true">close</span>
                </button>
            </div>
            <div class="synth-header-row">
                <select class="synth-midi-port" data-i18n-title="synth.midiPort"></select>
                <select class="synth-channel">${channelOptions}</select>
            </div>
        </div>
        <div class="synth-body">
            <div class="synth-zones-row">
                <span class="synth-zones-label">
                    <span data-i18n="synth.zonesLabel"></span>
                    <em class="zones-val"></em>
                </span>
                <div class="flex-filler"></div>
                <button class="synth-eye-btn" data-i18n-title="synth.toggleHighlight"><span class="material-symbols-outlined" aria-hidden="true">visibility</span></button>
                <button class="synth-add-zone-btn" data-i18n-title="synth.addZone">
                    <span class="material-symbols-outlined" aria-hidden="true">select</span>
                </button>
                <button class="synth-clear-zones-btn" data-i18n-title="synth.clearZones">
                    <span class="material-symbols-outlined" aria-hidden="true">deselect</span>
                </button>
                <button class="synth-reading-direction-btn" data-direction="leftToRight" data-i18n-title="synth.readingDirection.leftToRight">
                    <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>
                </button>
                <button class="synth-loop-btn active" data-i18n-title="synth.toggleLoop">
                    <span class="material-symbols-outlined" aria-hidden="true">laps</span>
                </button>
                <button class="synth-back-n-forth-btn" data-i18n-title="synth.toggleBackAndForth">
                    <span class="material-symbols-outlined" aria-hidden="true">sync_alt</span>
                </button>
            </div>

            <div class="synth-controls-row">
                <select class="synth-tempo">
                    <option value=1>1/1</option>
                    <option value=0.75>3/4</option>
                    <option value=0.66>2/3</option>
                    <option value=0.5>1/2</option>
                    <option value=0.33>1/3</option>
                    <option value=0.25>1/4</option>
                </select>
                <button class="synth-rewind" data-i18n-title="synth.rewind">
                    <span class="material-symbols-outlined" aria-hidden="true">fast_rewind</span>
                </button>
                <button class="synth-play">
                    <span class="material-symbols-outlined synth-play-icon" aria-hidden="true">play_arrow</span>
                    <span class="synth-play-label"></span>
                </button>
                <button class="synth-step-forward" data-i18n-title="synth.stepForward">
                    <span class="material-symbols-outlined" aria-hidden="true">step</span>
                </button>
            </div>

            <div class="synth-mode-row">
                    <button class="synth-mode-btn active" data-mode="monophonic"></button>
                    <button class="synth-mode-btn" data-mode="polyphonic"></button>
                    <button class="synth-toggle-full-options" data-i18n-title="synth.toggleFullOptions">
                        <span class="material-symbols-outlined" aria-hidden="true">expand_circle_up</span>
                    </button>
            </div>

            <div class="synth-full-options">
                <div class="synth-mode-panel synth-mode-panel-mono">
                    <div class="synth-note-range">
                        <button class="synth-bass" data-i18n-title="synth.noteRangeBass">𝄢</button>
                        <button class="synth-medium" data-i18n-title="synth.noteRangeMedium">𝄡</button>
                        <button class="synth-treble" data-i18n-title="synth.noteRangeTreble">𝄞</button>
                    </div>
                    <label class="hue-shift synth-slider-label">
                        <span><span data-i18n="synth.hueShift"></span> <em class="hue-shift-val">0°</em></span>
                        <input type="range" class="slider synth-hue-shift" min="0" max="360" value="0" step="1" />
                    </label>
                </div>

                <div class="synth-mode-panel synth-mode-panel-poly hidden">
                    <span class="synth-mode-panel-label" data-i18n="synth.channelsPanelLabel"></span>
                    <div class="synth-channel-toggles">
                        <div class="synth-channel-toggle-group">
                            <button class="synth-channel-toggle channel-red active" data-channel="0" data-i18n-title="synth.toggleRed">R</button>
                            <div class="synth-note-range">
                                <button class="synth-bass" data-i18n-title="synth.noteRangeBass">𝄢</button>
                                <button class="synth-medium" data-i18n-title="synth.noteRangeMedium">𝄡</button>
                                <button class="synth-treble" data-i18n-title="synth.noteRangeTreble">𝄞</button>
                            </div>
                        </div>
                        <div class="synth-channel-toggle-group">
                            <button class="synth-channel-toggle channel-green active" data-channel="1" data-i18n-title="synth.toggleGreen">G</button>
                            <div class="synth-note-range">
                                <button class="synth-bass" data-i18n-title="synth.noteRangeBass">𝄢</button>
                                <button class="synth-medium" data-i18n-title="synth.noteRangeMedium">𝄡</button>
                                <button class="synth-treble" data-i18n-title="synth.noteRangeTreble">𝄞</button>
                            </div>
                        </div>
                        <div class="synth-channel-toggle-group">
                            <button class="synth-channel-toggle channel-blue active" data-channel="2" data-i18n-title="synth.toggleBlue">B</button>
                            <div class="synth-note-range">
                                <button class="synth-bass" data-i18n-title="synth.noteRangeBass">𝄢</button>
                                <button class="synth-medium" data-i18n-title="synth.noteRangeMedium">𝄡</button>
                                <button class="synth-treble" data-i18n-title="synth.noteRangeTreble">𝄞</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="note-lengths">
                    <button class="note-length-btn noto-music" data-length="sixteenth" data-i18n-title="synth.noteLengthSixteenth">𝅘𝅥𝅯</button>
                    <button class="note-length-btn noto-music" data-length="eighth" data-i18n-title="synth.noteLengthEighth">𝅘𝅥𝅮</button>
                    <button class="note-length-btn noto-music active" data-length="quarter" data-i18n-title="synth.noteLengthQuarter">𝅘𝅥</button>
                    <button class="note-length-btn noto-music" data-length="half" data-i18n-title="synth.noteLengthHalf">𝅗𝅥</button>
                    <button class="note-length-btn noto-music" data-length="whole" data-i18n-title="synth.noteLengthWhole">𝅝</button>
                    <button class="synth-reverse-note-length" data-i18n-title="synth.reverseNoteLength">
                        <span class="material-symbols-outlined" aria-hidden="true">reset_exposure</span>
                    </button>
                </div>
                
                <div class="brightness-threshold synth-range-wrapper">
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
                    <span><span data-i18n="synth.velocityMin"></span> <em class="velocity-min-val">0</em></span>
                    <input type="range" class="slider synth-velocity-min" min="0" max="126" value="0" step="1" />
                </label>
                <p class="synth-pixel-info"></p>    
            </div>
        </div>
    `;

    // Translate everything marked with data-i18n* above, plus the elements
    // whose text depends on dynamic state (title, play button, pixel info).
    applyTranslations(el);
    el.querySelector('.synth-title-label').textContent = synthDisplayName(id);
    setPlayButtonState(el.querySelector('.synth-play'), false);
    el.querySelector('.synth-mode-btn[data-mode="monophonic"]').textContent = t('synth.modeMonophonic');
    el.querySelector('.synth-mode-btn[data-mode="polyphonic"]').textContent = t('synth.modePolyphonic');

    el.querySelector('.synth-pixel-info').textContent = t('synth.pixelInfoEmpty');

    // Reflect the backend-driven initial state (default-synth template)
    if (cfg) applySynthConfig(el, cfg);

    el.querySelector('.synth-play').addEventListener('click', () => onSynthPlayClick(id, el));

    // ---- Save this synth's settings as the default template ----
    const saveTemplateBtn = el.querySelector('.synth-save-template');
    saveTemplateBtn.addEventListener('click', () => {
        invoke('set_default_synth_from', { id })
            .then(() => {
                saveTemplateBtn.classList.add('active');
                setTimeout(() => saveTemplateBtn.classList.remove('active'), 800);
            })
            .catch(err => console.error('Error in set_default_synth_from:', err));
    });

    // ---- Custom name: double-click the title to rename it ----
    const titleLabel = el.querySelector('.synth-title-label');
    titleLabel.addEventListener('dblclick', () => {
        if (el.querySelector('.synth-title-input')) return; // already editing

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'synth-title-input';
        input.maxLength = 32;
        input.value = synthNames.get(id) ?? '';

        titleLabel.classList.add('hidden');
        titleLabel.after(input);
        input.focus();
        input.select();

        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            input.remove();
            titleLabel.classList.remove('hidden');
        };
        const commit = () => {
            if (closed) return;
            const name = input.value.trim();
            if (name) synthNames.set(id, name);
            else synthNames.delete(id);
            invoke('set_synth_name', { id, name: input.value })
                .catch(err => console.error('Error in set_synth_name:', err));
            titleLabel.textContent = synthDisplayName(id);
            close();
        };
        const cancel = () => {
            close();
        };

        input.addEventListener('keydown', (e) => {
            // Enter commits, Escape cancels; stopPropagation prevents the
            // global Escape handler (zone picking) from firing as well
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') cancel();
        });
        input.addEventListener('blur', commit);
    });
    el.querySelector('.synth-step-forward').addEventListener('click', () => {
        invoke('step_synth', { id })
            .catch(err => console.error('Error in step_synth:', err));
    });
    el.querySelector('.synth-rewind').addEventListener('click', () => {
        invoke('reset_synth_cursor', { id })
            .catch(err => console.error('Error in reset_synth_cursor:', err));
    });
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

    // MIDI output port: one connection per port is opened lazily by the
    // backend, so several synths can drive different MIDI interfaces.
    const midiPortSelect = el.querySelector('.synth-midi-port');
    invoke('list_midi_ports').then(ports => {
        midiPortSelect.innerHTML = ports.length > 0
            ? ports.map(p => `<option value="${p.index}">${p.name}</option>`).join('')
            : `<option value="0">${t('synth.noMidiPort')}</option>`;
        // Reflect the template's port; if it no longer exists (interface
        // unplugged), fall back to port 0 on both sides.
        if (cfg && ports.some(p => p.index === cfg.midi_port)) {
            midiPortSelect.value = String(cfg.midi_port);
        } else if (cfg && cfg.midi_port > 0) {
            midiPortSelect.value = '0';
            invoke('set_synth_midi_port', { id, port: 0 })
                .catch(err => console.error('Error in set_synth_midi_port:', err));
        }
    }).catch(err => console.error('Error in list_midi_ports:', err));
    midiPortSelect.addEventListener('change', (e) => {
        invoke('set_synth_midi_port', { id, port: Number(e.target.value) })
            .catch(err => console.error('Error in set_synth_midi_port:', err));
    });

    // Tempo relative to the main metronome (e.g. 0.5 = one pixel every two ticks)
    el.querySelector('.synth-tempo').addEventListener('change', (e) => {
        invoke('set_synth_tempo', { id, tempo: Number(e.target.value) })
            .catch(err => console.error('Error in set_synth_tempo:', err));
        updateZonesLabel(id);
    });

    // ---- Loop / back-and-forth (mutually exclusive) ----
    const loopBtn = el.querySelector('.synth-loop-btn');
    const backNForthBtn = el.querySelector('.synth-back-n-forth-btn');
    loopBtn.addEventListener('click', () => {
        const loopEnabled = !loopBtn.classList.contains('active');
        loopBtn.classList.toggle('active', loopEnabled);
        if (loopEnabled) backNForthBtn.classList.remove('active');
        invoke('set_synth_loop', { id, loopEnabled })
            .catch(err => console.error('Error in set_synth_loop:', err));
    });
    backNForthBtn.addEventListener('click', () => {
        const enabled = !backNForthBtn.classList.contains('active');
        backNForthBtn.classList.toggle('active', enabled);
        if (enabled) loopBtn.classList.remove('active');
        invoke('set_synth_back_n_forth', { id, enabled })
            .catch(err => console.error('Error in set_synth_back_n_forth:', err));
    });

    // ---- Reading direction: cycles left→right / right→left / top→bottom
    // / bottom→top ----
    const directionBtn = el.querySelector('.synth-reading-direction-btn');
    directionBtn.addEventListener('click', () => {
        const order = Object.keys(READING_DIRECTION_ICONS);
        const current = order.indexOf(directionBtn.dataset.direction);
        const direction = order[(current + 1) % order.length];
        directionBtn.dataset.direction = direction;
        updateReadingDirectionBtn(directionBtn);
        invoke('set_synth_reading_direction', { id, direction })
            .catch(err => console.error('Error in set_synth_reading_direction:', err));
    });
    updateReadingDirectionBtn(directionBtn);

    // ---- Collapse/expand the full options section ----
    const fullOptions = el.querySelector('.synth-full-options');
    const toggleFullOptionsBtn = el.querySelector('.synth-toggle-full-options');
    toggleFullOptionsBtn.addEventListener('click', () => {
        const collapsed = fullOptions.classList.toggle('hidden');
        toggleFullOptionsBtn.querySelector('.material-symbols-outlined').textContent =
            collapsed ? 'expand_circle_down' : 'expand_circle_up';
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

    // ---- Note range filters (bass / medium / treble) ----
    // Mono panel has one filter for the single note; each polyphonic voice
    // has its own. Toggles are cumulative and all-off means full 0–127.
    el.querySelectorAll('.synth-note-range button').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            sendSynthNoteRanges(id, el);
        });
    });

    // ---- Note lengths: brightness → duration mapping ----
    // At least one length must stay enabled: clicking the last remaining
    // active button does nothing.
    el.querySelectorAll('.note-length-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const wasActive = btn.classList.contains('active');
            if (wasActive && el.querySelectorAll('.note-length-btn.active').length === 1) {
                return;
            }
            btn.classList.toggle('active');
            sendSynthNoteLengths(id, el);
        });
    });
    // Sync the default state (quarter checked) with the backend
    sendSynthNoteLengths(id, el);
    el.querySelector('.synth-reverse-note-length').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const reversed = !btn.classList.contains('active');
        btn.classList.toggle('active', reversed);
        invoke('set_synth_note_length_reversed', { id, reversed })
            .catch(err => console.error('Error in set_synth_note_length_reversed:', err));
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

    // Initialize the highlight state (hidden by default, whole image selected)
    synthHighlights.set(id, { visible: false, zones: [] });
    updateZonesLabel(id);

    // Eye button
    el.querySelector('.synth-eye-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const hi = synthHighlights.get(id); 
        hi.visible = !hi.visible;
        btn.classList.toggle('active', hi.visible);
        if (hi.visible) drawRangeHighlight(id);
        else            clearRangeHighlight(id);
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

    // Zone drawing: arm/cancel the rectangle-drawing mode on the image
    el.querySelector('.synth-add-zone-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        if (zonePickState && zonePickState.id === id) {
            cancelZonePicking();
        } else {
            startZonePicking(id, btn);
        }
    });

    // Clear all zones: back to the whole image
    el.querySelector('.synth-clear-zones-btn').addEventListener('click', () => {
        const hi = synthHighlights.get(id);
        if (!hi) return;
        hi.zones = [];
        sendSynthZones(id);
        updateZonesLabel(id);
        redrawAllHighlights();
    });

    initBrightnessRange(id, el);

    return el;
}

function updateAllSynthZones() {
    synthListBody.querySelectorAll('.synth-block').forEach(el => {
        const synthId = Number(el.dataset.synthId);
        const hi = synthHighlights.get(synthId);
        if (!hi) return;

        // Clip the zones to the new grid and drop the ones
        // that no longer intersect the image
        hi.zones = hi.zones
            .map(z => ({
                x: z.x,
                y: z.y,
                w: Math.min(z.w, gridW - z.x),
                h: Math.min(z.h, gridH - z.y),
            }))
            .filter(z => z.w > 0 && z.h > 0);

        sendSynthZones(synthId);
        updateZonesLabel(synthId);
    });
    redrawAllHighlights();
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
// (hue shift, R/G/B toggles, velocity, loop, highlight...)
// remains editable on the fly while the synth is playing.
function setSynthControlsLocked(el, locked) {
    el.querySelector('.synth-channel').disabled = locked;
    el.querySelector('.synth-midi-port').disabled = locked;
    el.querySelectorAll('.synth-mode-btn').forEach(btn => { btn.disabled = locked; });
    el.querySelector('.synth-add-zone-btn').disabled = locked;
    el.querySelector('.synth-clear-zones-btn').disabled = locked;
    el.querySelector('.synth-step-forward').disabled = locked;

    // If this synth was mid-selection when it started playing, cancel it.
    const id = Number(el.dataset.synthId);
    if (locked && zonePickState && zonePickState.id === id) {
        cancelZonePicking();
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

    if (zonePickState && zonePickState.id === id) cancelZonePicking();

    synthColors.delete(id);
    synthCursors.delete(id);
    synthHighlights.delete(id);
    synthNames.delete(id);
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
        const synth = await invoke('add_synth');
        placeholder.classList.add('hidden');
        synthListBody.appendChild(createSynthElement(synth.id, synth));
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