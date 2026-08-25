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