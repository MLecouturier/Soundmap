const { invoke } = window.__TAURI__.core;

// ---------- Éléments ----------
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

// Contrôles d'image à verrouiller pendant la lecture d'un synthétiseur
// (le bouton "Voir l'original" reste volontairement exclu)
const imageLockControls = [loadBtn, resetBtn, gridSlider, contrast, brightness, grayscale, posterize];

// Verrouille/déverrouille les contrôles d'image selon qu'un synthé joue ou non
function updateImageControlsLockState() {
    const anyPlaying = synthListBody.querySelectorAll('.synth-play.active').length > 0;
    imageLockControls.forEach(el => { el.disabled = anyPlaying; });
    document.querySelector('#controls').classList.toggle('locked', anyPlaying);
}

// ---------- Canvas overlay ----------
let gridW = 1; // largeur courante de la grille en pixels
let gridH = 1; // hauteur courante de la grille en pixels

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

    // Dimensions rendues de l'image dans le viewer (object-fit: contain)
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

    // Effacer uniquement le pixel précédent de ce synthé
    const prev = synthCursors.get(synthId);
    if (prev !== undefined) {
        const pc = prev % gridW;
        const pr = Math.floor(prev / gridW);
        ctx.clearRect(
            offsetX + pc * cellW - 1,
            offsetY + pr * cellH - 1,
            cellW + 2, cellH + 2
        );
        // Redessiner les autres synthés qui occupent ce pixel
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

// Calcule les dimensions de rendu de l'image dans le viewer (object-fit: contain)
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
    // On redessine tout le canvas à partir de zéro (plus sûr que de cibler zone par zone)
    redrawAllHighlights();
}

function redrawAllHighlights() {
    const ctx = pixelOverlay.getContext('2d');
    ctx.clearRect(0, 0, pixelOverlay.width, pixelOverlay.height);
    synthCursors.clear(); // les curseurs actifs seront redessinés au prochain tick
    synthHighlights.forEach((_, sid) => drawRangeHighlight(sid));
}

new ResizeObserver(() => {
    resizeOverlay();
    clearOverlay();
}).observe(pixelOverlay);

// ---------- État ----------
let hasImage      = false;
let origWidth     = 0;
let origHeight    = 0;
let originalPng   = null;   // base64 de l'aperçu original
let processedPng  = null;   // base64 du dernier rendu traité
let totalPixels   = 0;      // nombre total de pixels dans la grille courante

// Couleurs prédéfinies pour les synthés
const SYNTH_COLORS = [
    '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
    '#1abc9c', '#3498db', '#9b59b6', '#e91e63',
    '#ff5722', '#00bcd4', '#8bc34a', '#ffffff',
];

// Map id → couleur courante
const synthColors = new Map();

// Map id → { visible: bool, start: number, end: number }
const synthHighlights = new Map();

const SLIDER_STEPS = 1000;
const MIN_CELLS    = 2;

// ---------- Échelle logarithmique ----------
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

// ---------- Paramètres ----------
function buildParams() {
  const levels = Number(posterize.value);
  return {
    grid_width:       currentGridWidth(),
    grid_height:      null,              // toujours déduit du ratio
    contrast:         Number(contrast.value),
    brightness:       Number(brightness.value),
    grayscale:        grayscale.checked,
    posterize_levels: levels > 1 ? levels : null,
  };
}

// ---------- Affichage ----------
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
  posterizeValue.textContent = p > 1 ? `${p} niveaux` : 'off';
}

// ---------- Rafraîchissement ----------
let pending = false;

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
    updateAllSynthRangeMax(totalPixels);

    dimensionsInfo.textContent =
      `Original : ${origWidth} × ${origHeight}  —  ` +
      `Grille : ${result.width} × ${result.height}  (${result.cell_count} cellules)`;
  } catch (err) {
    console.error('Erreur lors du traitement :', err);
    dimensionsInfo.textContent = `Erreur : ${err}`;
  } finally {
    pending = false;
  }
}

let debounceId = null;
function scheduleRefresh(delay = 60) {
  clearTimeout(debounceId);
  debounceId = setTimeout(refresh, delay);
}

// ---------- Chargement ----------
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
    console.error('Erreur lors du chargement de l\'image :', err);
  }
});

// ---------- Réinitialisation ----------
resetBtn.addEventListener('click', () => {
  gridSlider.value  = SLIDER_STEPS;
  grayscale.checked = false;
  contrast.value    = 0;
  brightness.value  = 0;
  posterize.value   = 1;

  syncLabels();
  refresh();
});

// ---------- Écouteurs ----------
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

// ---------- Métronome ----------
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

// Démarre le métronome Rust s'il n'est pas déjà en cours
async function ensureMetronomeStarted() {
    if (metronomeRunning) return;
    await invoke('set_metronome_bpm', { bpm: clampBpm(Number(bpmInput.value)) });
    await invoke('start_metronome');
    metronomeRunning = true;
}

// Arrête le métronome Rust s'il n'y a plus aucun synthé en lecture
async function stopMetronomeIfIdle() {
    if (!metronomeRunning) return;
    const anyPlaying = synthListBody.querySelectorAll('.synth-play.active').length > 0;
    if (anyPlaying) return;

    await invoke('stop_metronome');
    metronomeRunning = false;

    // Restaurer les highlights masqués pendant la lecture
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

// Saisie directe au clavier : on valide au blur ou sur "Enter"
bpmInput.addEventListener('change', () => applyBpm(Number(bpmInput.value)));

// Support clavier : flèches ↑/↓ pour incrémenter/décrémenter de 1
bpmInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
        event.preventDefault(); // évite le comportement natif du <input type="number">
        applyBpm(Number(bpmInput.value) + 1);
    } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        applyBpm(Number(bpmInput.value) - 1);
    }
});

// Écoute des ticks émis par le backend Rust
window.__TAURI__.event.listen('metronome-tick', (event) => {
    metronomeLed.classList.add('active');
    setTimeout(() => metronomeLed.classList.remove('active'), 100);
});

// ==========================================
// Synthétiseurs
// ==========================================
const addSynthBtn   = document.querySelector('#add-synth-btn');
const playAllBtn    = document.querySelector('#play-all-btn');
const synthListBody = document.querySelector('.synth-list-body');
const placeholder   = synthListBody.querySelector('.placeholder-text');

function createSynthElement(id) {
    const el = document.createElement('div');
    el.className = 'synth-block';
    el.dataset.synthId = id;

    // Couleur par défaut : rotation dans la palette
    const defaultColor = SYNTH_COLORS[(synthColors.size) % SYNTH_COLORS.length];
    synthColors.set(id, defaultColor);

    const channelOptions = Array.from({ length: 16 }, (_, i) =>
        `<option value="${i}">Canal ${i + 1}</option>`
    ).join('');

    const maxPx = totalPixels > 0 ? totalPixels - 1 : 0;

    const colorSwatches = SYNTH_COLORS.map(c =>
        `<button class="color-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`
    ).join('');

    el.innerHTML = `
        <div class="synth-color-band" style="background:${defaultColor}" title="Choisir une couleur"></div>
        <div class="synth-color-picker hidden">
            <div class="color-swatches">${colorSwatches}</div>
        </div>
        <div class="synth-header">
            <span>Synthé #${id}</span>
            <button class="synth-remove" title="Supprimer">✕</button>
        </div>
        <div class="synth-body">
            <div class="synth-controls-row">
                <button class="synth-play">▶ Play</button>
                <button class="synth-loop-btn active" title="Activer/désactiver la boucle">Boucle</button>
                <button class="synth-eye-btn" title="Afficher/masquer le surlignage du range"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z" /></svg></button>
            </div>
            <label class="synth-channel-label">
                <span>Canal MIDI</span>
                <select class="synth-channel">${channelOptions}</select>
            </label>
            <div class="synth-range-wrapper">
                <div class="synth-range-labels">
                    <span>Pixels</span>
                    <span class="synth-range-values">
                        <em class="range-start-val">0</em> – <em class="range-end-val">${maxPx}</em>
                    </span>
                </div>
                <div class="synth-range-track">
                    <div class="synth-range-fill"></div>
                    <input type="range" class="synth-range-input range-start" min="0" max="${maxPx}" value="0" step="1" />
                    <input type="range" class="synth-range-input range-end"   min="0" max="${maxPx}" value="${maxPx}" step="1" />
                </div>
            </div>
            <div class="synth-range-wrapper">
                <div class="synth-range-labels">
                    <span>Seuil de luminosité</span>
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
                <span>Seuil de variation <em class="threshold-val">0</em></span>
                <input type="range" class="slider synth-threshold" min="0" max="24" value="0" step="1" />
            </label>
            <p class="synth-pixel-info">Pixel : -</p>
        </div>
    `;

    el.querySelector('.synth-play').addEventListener('click', () => onSynthPlayClick(id, el));
    el.querySelector('.synth-remove').addEventListener('click', () => onSynthRemoveClick(id, el));

    // Bande de couleur → toggle du picker
    const colorBand   = el.querySelector('.synth-color-band');
    const colorPicker = el.querySelector('.synth-color-picker');
    colorBand.addEventListener('click', () => {
        // Fermer les autres pickers ouverts
        document.querySelectorAll('.synth-color-picker').forEach(p => {
            if (p !== colorPicker) p.classList.add('hidden');
        });
        colorPicker.classList.toggle('hidden');
    });

    // Clic sur une couleur
    colorPicker.querySelectorAll('.color-swatch').forEach(btn => {
        btn.addEventListener('click', () => {
            const color = btn.dataset.color;
            synthColors.set(id, color);
            colorBand.style.background = color;
            colorPicker.classList.add('hidden');
            // Redessiner le surlignage avec la nouvelle couleur
            redrawAllHighlights();
        });
    });

    // Fermer le picker en cliquant ailleurs
    document.addEventListener('click', (e) => {
        if (!el.contains(e.target)) colorPicker.classList.add('hidden');
    });
    el.querySelector('.synth-channel').addEventListener('change', (e) => {
        invoke('set_synth_channel', { id, channel: Number(e.target.value) })
            .catch(err => console.error('Erreur set_synth_channel :', err));
    });

    el.querySelector('.synth-loop-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const loopEnabled = !btn.classList.contains('active');
        btn.classList.toggle('active', loopEnabled);
        invoke('set_synth_loop', { id, loopEnabled })
            .catch(err => console.error('Erreur set_synth_loop :', err));
    });

    // Initialiser l'état du highlight (masqué par défaut)
    synthHighlights.set(id, { visible: false, start: 0, end: maxPx });

    // Bouton œil
    el.querySelector('.synth-eye-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        const hi = synthHighlights.get(id);
        hi.visible = !hi.visible;
        btn.classList.toggle('active', hi.visible);
        if (hi.visible) drawRangeHighlight(id);
        else            clearRangeHighlight(id);
    });

    // Slider seuil de variation
    const thresholdInput = el.querySelector('.synth-threshold');
    const thresholdVal   = el.querySelector('.threshold-val');
    thresholdInput.addEventListener('input', () => {
        const threshold = Number(thresholdInput.value);
        thresholdVal.textContent = threshold === 0 ? 'off' : threshold;
        invoke('set_synth_threshold', { id, threshold })
            .catch(err => console.error('Erreur set_synth_threshold :', err));
    });
    thresholdVal.textContent = 'off';

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

        // Le thumb gauche doit toujours être cliquable : on le passe devant
        // quand il est proche ou égal au thumb droit
        const atEnd = Number(startInput.value) >= Number(endInput.value);
        startInput.style.zIndex = atEnd ? '3' : '2';
        endInput.style.zIndex   = atEnd ? '1' : '2';
    }

    function sendRange() {
        const pixelStart = Number(startInput.value);
        const pixelEnd   = Number(endInput.value);
        invoke('set_synth_range', { id, pixelStart, pixelEnd })
            .catch(err => console.error('Erreur set_synth_range :', err));
        // Mettre à jour le highlight si visible
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
        }).catch(err => console.error('Erreur set_synth_brightness_range :', err));
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

        // Reclamper les valeurs si elles dépassent le nouveau max
        if (Number(startInput.value) > maxPx) startInput.value = maxPx;
        if (Number(endInput.value)   > maxPx || Number(endInput.value) === 0) endInput.value = maxPx;

        endVal.textContent = endInput.value;
        el.querySelector('.synth-range-fill') && initFillUpdate(el);

        // Recaler les bornes du highlight
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

// Met à jour le libellé du bouton "play all" selon l'état courant des synthés
function syncPlayAllButton() {
    const blocks = Array.from(synthListBody.querySelectorAll('.synth-block'));
    const anyPlaying = blocks.some(el => el.querySelector('.synth-play').classList.contains('active'));
    playAllBtn.textContent = anyPlaying ? '⏸' : '▶';
    playAllBtn.title = anyPlaying
        ? 'Arrêter tous les synthétiseurs'
        : 'Démarrer tous les synthétiseurs';
}

async function startSynthPlayback(id, el) {
    const btn = el.querySelector('.synth-play');
    await ensureMetronomeStarted();
    await invoke('start_synth', { id });
    btn.textContent = '⏸ Stop';
    btn.classList.add('active');
    // Masquer le surlignage pendant la lecture
    hideHighlightForPlay(id);
    // Verrouiller le canal MIDI de ce synthé pendant la lecture
    el.querySelector('.synth-channel').disabled = true;
    updateImageControlsLockState();
}

async function stopSynthPlayback(id, el) {
    const btn = el.querySelector('.synth-play');
    await invoke('stop_synth', { id });
    btn.textContent = '▶ Play';
    btn.classList.remove('active');
    // Réafficher le surlignage si le bouton œil est actif
    restoreHighlightAfterStop(id, el);
    await stopMetronomeIfIdle();
    // Déverrouiller le canal MIDI de ce synthé
    el.querySelector('.synth-channel').disabled = false;
    updateImageControlsLockState();
}

function hideHighlightForPlay(id) {
    const hi = synthHighlights.get(id);
    if (!hi) return;
    hi._wasVisible = hi.visible; // mémoriser l'état
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
    // Effacer le curseur de ce synthé du canvas
    synthCursors.delete(id);
    redrawAllHighlights();
}

async function onSynthRemoveClick(id, el) {
    await invoke('stop_synth', { id }).catch(() => {});
    await invoke('remove_synth', { id });

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
        console.error('Erreur lors de l\'ajout du synthétiseur :', err);
        alert(err); // ou un affichage plus discret type toast/message d'erreur dans l'UI
    }
});

// ---------- Démarrer/arrêter tous les synthétiseurs ----------
playAllBtn.addEventListener('click', async () => {
    const blocks = Array.from(synthListBody.querySelectorAll('.synth-block'));
    if (blocks.length === 0) return;

    // On considère l'ensemble "en lecture" si au moins un synthé joue déjà.
    const anyPlaying = blocks.some(el => el.querySelector('.synth-play').classList.contains('active'));

    if (anyPlaying) {
        // Tout arrêter
        for (const el of blocks) {
            const id = Number(el.dataset.synthId);
            if (el.querySelector('.synth-play').classList.contains('active')) {
                await stopSynthPlayback(id, el);
            }
        }
    } else {
        // Tout démarrer
        for (const el of blocks) {
            const id = Number(el.dataset.synthId);
            await startSynthPlayback(id, el);
        }
    }
    syncPlayAllButton();
});

// Arrêt automatique en fin de séquence (mode sans boucle)
window.__TAURI__.event.listen('synth-stopped', async (event) => {
    const { id } = event.payload;
    const el = synthListBody.querySelector(`[data-synth-id="${id}"]`);
    if (!el) return;
    const btn = el.querySelector('.synth-play');
    btn.textContent = '▶ Play';
    btn.classList.remove('active');
    synthCursors.delete(id);
    restoreHighlightAfterStop(id, el);
    syncPlayAllButton();
    await stopMetronomeIfIdle();
    // Déverrouiller le canal MIDI de ce synthé
    el.querySelector('.synth-channel').disabled = false;
    updateImageControlsLockState();
});

// Réception des ticks de pixels, un par synthé
window.__TAURI__.event.listen('synth-pixel-tick', (event) => {
    const { id, cursor, r, g, b, a, note, velocity, muted } = event.payload;
    const el = synthListBody.querySelector(`[data-synth-id="${id}"]`);
    if (!el) return;
    const noteName = midiNoteToName(note);
    const muteLabel = muted ? ' — muet' : '';
    el.querySelector('.synth-pixel-info').textContent =
        `Pixel ${cursor} — rgba(${r ?? '-'}, ${g ?? '-'}, ${b ?? '-'}, ${a ?? '-'}) — Note ${noteName} — Vel ${velocity ?? '-'}${muteLabel}`;
    drawSynthPixel(id, cursor, muted);
});

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiNoteToName(midi) {
    if (midi == null) return '-';
    const octave = Math.floor(midi / 12) - 1;
    const name = NOTE_NAMES[midi % 12];
    return `${name}${octave} (${midi})`;
}