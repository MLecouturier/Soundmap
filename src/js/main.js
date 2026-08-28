const { invoke } = window.__TAURI__.core;

// ---------- Éléments ----------
const loadBtn         = document.querySelector('#load-btn');
const resetBtn        = document.querySelector('#reset-btn');
const showOriginal    = document.querySelector('#show-original');
const preview         = document.querySelector('#preview');
const viewerEmpty     = document.querySelector('#viewer-empty');

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

// ---------- État ----------
let hasImage      = false;
let origWidth     = 0;
let origHeight    = 0;
let originalPng   = null;   // base64 de l'aperçu original
let processedPng  = null;   // base64 du dernier rendu traité
let totalPixels   = 0;      // nombre total de pixels dans la grille courante

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
const metronomeToggle = document.querySelector('#metronome-toggle');
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

async function toggleMetronome() {
    if (metronomeRunning) {
        await invoke('stop_metronome');
        metronomeRunning = false;
        metronomeToggle.textContent = '▶ Démarrer';

        // Remettre tous les boutons de synthés à l'état arrêté
        synthListBody.querySelectorAll('.synth-block').forEach(el => {
            const btn = el.querySelector('.synth-play');
            btn.textContent = '▶ Play';
            btn.classList.remove('active');
        });
    } else {
        await invoke('set_metronome_bpm', { bpm: clampBpm(Number(bpmInput.value)) });
        await invoke('start_metronome');
        metronomeRunning = true;
        metronomeToggle.textContent = '⏸ Arrêter';

        // Resynchroniser l'état visuel de chaque synthé avec l'état Rust
        for (const el of synthListBody.querySelectorAll('.synth-block')) {
            const id = Number(el.dataset.synthId);
            const isPlaying = await invoke('is_synth_playing', { id });
            const btn = el.querySelector('.synth-play');
            btn.textContent = isPlaying ? '⏸ Stop' : '▶ Play';
            btn.classList.toggle('active', isPlaying);
        }
    }
}

metronomeToggle.addEventListener('click', toggleMetronome);

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
const synthListBody = document.querySelector('.synth-list-body');
const placeholder   = synthListBody.querySelector('.placeholder-text');

function createSynthElement(id) {
    const el = document.createElement('div');
    el.className = 'synth-block';
    el.dataset.synthId = id;

    const channelOptions = Array.from({ length: 16 }, (_, i) =>
        `<option value="${i}">Canal ${i + 1}</option>`
    ).join('');

    const maxPx = totalPixels > 0 ? totalPixels - 1 : 0;

    el.innerHTML = `
        <div class="synth-header">
            <span>Synthé #${id}</span>
            <button class="synth-remove" title="Supprimer">✕</button>
        </div>
        <div class="synth-body">
            <div class="synth-controls-row">
                <button class="synth-play">▶ Play</button>
                <button class="synth-loop-btn active" title="Activer/désactiver la boucle">Boucle</button>
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
            <p class="synth-pixel-info">Pixel : -</p>
        </div>
    `;

    el.querySelector('.synth-play').addEventListener('click', () => onSynthPlayClick(id, el));
    el.querySelector('.synth-remove').addEventListener('click', () => onSynthRemoveClick(id, el));
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

    initSynthRange(id, el);

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
    });
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
    const btn = el.querySelector('.synth-play');
    const isPlaying = await invoke('is_synth_playing', { id });

    if (!isPlaying) {
        if (!metronomeRunning) {
            await invoke('set_metronome_bpm', { bpm: clampBpm(Number(bpmInput.value)) });
            await invoke('start_metronome');
            metronomeRunning = true;
            metronomeToggle.textContent = '⏸ Arrêter';
        }
        await invoke('start_synth', { id });
        btn.textContent = '⏸ Stop';
        btn.classList.add('active');
    } else {
        await invoke('stop_synth', { id });
        btn.textContent = '▶ Play';
        btn.classList.remove('active');
    }
}

async function onSynthRemoveClick(id, el) {
    await invoke('stop_synth', { id }).catch(() => {});
    await invoke('remove_synth', { id });

    el.remove();

    if (synthListBody.querySelectorAll('.synth-block').length === 0) {
        placeholder.classList.remove('hidden');
    }
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

// Arrêt automatique en fin de séquence (mode sans boucle)
window.__TAURI__.event.listen('synth-stopped', (event) => {
    const { id } = event.payload;
    const el = synthListBody.querySelector(`[data-synth-id="${id}"]`);
    if (!el) return;
    const btn = el.querySelector('.synth-play');
    btn.textContent = '▶ Play';
    btn.classList.remove('active');
});

// Réception des ticks de pixels, un par synthé
window.__TAURI__.event.listen('synth-pixel-tick', (event) => {
    const { id, cursor, r, g, b, a, note } = event.payload;
    const el = synthListBody.querySelector(`[data-synth-id="${id}"]`);
    if (!el) return;
    const noteName = midiNoteToName(note);
    el.querySelector('.synth-pixel-info').textContent =
        `Pixel ${cursor} — rgba(${r ?? '-'}, ${g ?? '-'}, ${b ?? '-'}, ${a ?? '-'}) — Note ${noteName}`;
});

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiNoteToName(midi) {
    if (midi == null) return '-';
    const octave = Math.floor(midi / 12) - 1;
    const name = NOTE_NAMES[midi % 12];
    return `${name}${octave} (${midi})`;
}