use crate::state::ImageState;
use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use tauri::State;

#[derive(Serialize)]
pub struct ImageInfo {
    pub base64_png: String,
    pub width: u32,
    pub height: u32,
    pub orig_width: u32,
    pub orig_height: u32,
    /// Nombre de cellules = nombre de notes potentielles
    pub cell_count: u32,
}

#[derive(Deserialize)]
pub struct AdjustmentParams {
    /// Largeur cible de la grille de lecture (en cellules)
    pub grid_width: u32,
    /// Hauteur cible ; si None, calculée d'après le ratio de l'original
    pub grid_height: Option<u32>,
    /// -100.0 .. 100.0
    pub contrast: f32,
    /// -100.0 .. 100.0
    pub brightness: i32,
    pub grayscale: bool,
    /// Nombre de niveaux par canal (2..=256). None = pas de postérisation
    pub posterize_levels: Option<u8>,
}

#[derive(Serialize)]
pub struct PixelData {
    pub width: u32,
    pub height: u32,
    /// RGBA à plat
    pub rgba: Vec<u8>,
    /// Luminance 0..255, un octet par cellule (pratique pour le mapping MIDI)
    pub luma: Vec<u8>,
}

fn encode_to_base64_png(img: &DynamicImage) -> Result<String, String> {
    let mut buffer = Cursor::new(Vec::new());
    img.write_to(&mut buffer, ImageFormat::Png)
        .map_err(|e| format!("Erreur d'encodage PNG: {e}"))?;
    Ok(general_purpose::STANDARD.encode(buffer.into_inner()))
}

/// Réduit le nombre de niveaux par canal.
/// `levels` = 2 donne du noir & blanc pur, 4 donne 4 paliers, etc.
fn posterize(img: &DynamicImage, levels: u8) -> DynamicImage {
    let levels = levels.clamp(2, 255) as u32;
    let step = 255.0 / (levels - 1) as f32;

    let mut rgba = img.to_rgba8();
    for pixel in rgba.pixels_mut() {
        for c in 0..3 {
            let v = pixel[c] as f32;
            let quantized = (v / step).round() * step;
            pixel[c] = quantized.clamp(0.0, 255.0) as u8;
        }
    }
    DynamicImage::ImageRgba8(rgba)
}

/// Construit l'image de travail à la résolution de la grille.
fn build_processed(original: &DynamicImage, params: &AdjustmentParams) -> DynamicImage {
    let (ow, oh) = (original.width(), original.height());

    let gw = params.grid_width.clamp(1, 4096);
    let gh = match params.grid_height {
        Some(h) => h.clamp(1, 4096),
        None => {
            // Conserve le ratio de l'original
            let ratio = oh as f32 / ow as f32;
            ((gw as f32 * ratio).round() as u32).max(1)
        }
    };

    // Downscale moyenneur : chaque cellule agrège sa zone source.
    // `resize_exact` + Triangle donne un bon compromis vitesse/qualité.
    // Pour un vrai box filter, Gaussian sur de forts ratios est plus fidèle
    // mais plus lent ; Triangle suffit largement ici.
    let mut img = original.resize_exact(gw, gh, image::imageops::FilterType::Triangle);

    if params.grayscale {
        img = DynamicImage::ImageLuma8(img.to_luma8());
    }

    if params.brightness != 0 {
        img = img.brighten(params.brightness);
    }

    if params.contrast != 0.0 {
        img = img.adjust_contrast(params.contrast);
    }

    if let Some(levels) = params.posterize_levels {
        img = posterize(&img, levels);
    }

    img
}

#[tauri::command]
pub async fn load_image(
    app_handle: tauri::AppHandle,
    state: State<'_, ImageState>,
) -> Result<ImageInfo, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app_handle
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "bmp", "gif", "webp", "tiff"])
        .blocking_pick_file();

    let path = file_path.ok_or_else(|| "Aucun fichier sélectionné".to_string())?;
    let path_buf = path
        .as_path()
        .ok_or_else(|| "Chemin de fichier invalide".to_string())?;

    let img = image::open(path_buf).map_err(|e| format!("Erreur de chargement: {e}"))?;

    let (width, height) = (img.width(), img.height());

    *state.original.lock().unwrap() = Some(img);
    // On ne remplit pas `processed` ici : le frontend appellera
    // apply_image_adjustments() juste après, avec ses paramètres courants.
    *state.processed.lock().unwrap() = None;

    // Aperçu de l'original, borné pour ne pas transférer un PNG énorme
    let preview_src = state.original.lock().unwrap().clone().unwrap();
    let preview = if width > 1200 || height > 1200 {
        preview_src.resize(1200, 1200, image::imageops::FilterType::Triangle)
    } else {
        preview_src
    };

    Ok(ImageInfo {
        base64_png: encode_to_base64_png(&preview)?,
        width,
        height,
        orig_width: width,
        orig_height: height,
        cell_count: width * height,
    })
}

#[tauri::command]
pub fn apply_image_adjustments(
    state: State<'_, ImageState>,
    params: AdjustmentParams,
) -> Result<ImageInfo, String> {
    // On récupère les dimensions de l'original ET l'image traitée
    // dans le même verrou, puis on relâche.
    let (orig_width, orig_height, processed) = {
        let guard = state.original.lock().unwrap();
        let original = guard
            .as_ref()
            .ok_or_else(|| "Aucune image chargée".to_string())?;

        (
            original.width(),
            original.height(),
            build_processed(original, &params),
        )
    };

    let (width, height) = (processed.width(), processed.height());
    let base64_png = encode_to_base64_png(&processed)?;

    *state.processed.lock().unwrap() = Some(processed);

    Ok(ImageInfo {
        base64_png,
        width,
        height,
        orig_width,
        orig_height,
        cell_count: width * height,
    })
}

#[tauri::command]
pub fn get_pixel_data(state: State<'_, ImageState>) -> Result<PixelData, String> {
    let guard = state.processed.lock().unwrap();
    let processed = guard
        .as_ref()
        .ok_or_else(|| "Aucune image traitée disponible".to_string())?;

    let (width, height) = (processed.width(), processed.height());
    let rgba_img = processed.to_rgba8();
    let luma_img = processed.to_luma8();

    Ok(PixelData {
        width,
        height,
        rgba: rgba_img.into_raw(),
        luma: luma_img.into_raw(),
    })
}

/// Renvoie les dimensions de la grille sans encoder d'image.
/// Utile pour afficher le nombre de notes avant traitement.
#[tauri::command]
pub fn get_grid_info(state: State<'_, ImageState>) -> Result<(u32, u32), String> {
    let guard = state.processed.lock().unwrap();
    let processed = guard
        .as_ref()
        .ok_or_else(|| "Aucune image traitée".to_string())?;
    Ok((processed.width(), processed.height()))
}