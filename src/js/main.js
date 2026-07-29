const { invoke } = window.__TAURI__.core;

const preview = document.getElementById('preview');
const loadBtn = document.getElementById('load-btn');
const contrastSlider = document.getElementById('contrast');
const contrastValue = document.getElementById('contrast-value');
const maxWidthInput = document.getElementById('max-width');
const maxHeightInput = document.getElementById('max-height');
const dimensionsInfo = document.getElementById('dimensions-info');

let hasImage = false;

loadBtn.addEventListener('click', async () => {
  try {
    const result = await invoke('load_image');
    preview.src = `data:image/png;base64,${result.base64_png}`;
    dimensionsInfo.textContent = `Dimensions originales : ${result.width} x ${result.height}`;
    hasImage = true;
  } catch (error) {
    console.error('Erreur lors du chargement de l\'image:', error);
    alert(`Erreur: ${error}`);
  }
});

async function applyAdjustments() {
  if (!hasImage) return;

  try {
    const result = await invoke('apply_image_adjustments', {
      params: {
        contrast: parseFloat(contrastSlider.value),
        max_width: parseInt(maxWidthInput.value, 10),
        max_height: parseInt(maxHeightInput.value, 10),
      },
    });
    preview.src = `data:image/png;base64,${result.base64_png}`;
    dimensionsInfo.textContent = `Dimensions traitées : ${result.width} x ${result.height}`;
  } catch (error) {
    console.error('Erreur lors de l\'ajustement:', error);
    alert(`Erreur: ${error}`);
  }
}

contrastSlider.addEventListener('input', () => {
  contrastValue.textContent = contrastSlider.value;
});

contrastSlider.addEventListener('change', applyAdjustments);
maxWidthInput.addEventListener('change', applyAdjustments);
maxHeightInput.addEventListener('change', applyAdjustments);
