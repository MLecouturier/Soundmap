use crate::state::ImageState;
use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use tauri::State;

#[derive(Serialize)]
pub struct ImageInfo {
    pub base64_png: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize)]
pub struct AdjustmentParams {
    pub contrast: f32,
    pub max_width: u32,
    pub max_height: u32,
}

#[derive(Serialize)]
pub struct PixelData {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>, // RGBA à plat : r,g,b,a, r,g,b,a, ...
}

fn encode_to_base64_png(img: &DynamicImage) -> Result<String, String> {
    let mut buffer = Cursor::new(Vec::new());
    img.write_to(&mut buffer, ImageFormat::Png)
        .map_err(|e| format!("Erreur d'encodage PNG: {}", e))?;
    Ok(general_purpose::STANDARD.encode(buffer.into_inner()))
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
        .add_filter("Images", &["png", "jpg", "jpeg", "bmp", "gif"])
        .blocking_pick_file();

    let path = file_path.ok_or_else(|| "Aucun fichier sélectionné".to_string())?;

    let path_buf = path
        .as_path()
        .ok_or_else(|| "Chemin de fichier invalide".to_string())?;

    let img = image::open(path_buf)
        .map_err(|e| format!("Erreur de chargement de l'image: {}", e))?;

    let (width, height) = img.dimensions();
    let base64_png = encode_to_base64_png(&img)?;

    *state.original.lock().unwrap() = Some(img.clone());
    *state.processed.lock().unwrap() = Some(img);

    Ok(ImageInfo {
        base64_png,
        width,
        height,
    })
}

#[tauri::command]
pub fn apply_image_adjustments(
    state: State<'_, ImageState>,
    params: AdjustmentParams,
) -> Result<ImageInfo, String> {
    let original_guard = state.original.lock().unwrap();
    let original = original_guard
        .as_ref()
        .ok_or_else(|| "Aucune image chargée".to_string())?;

    // resize() conserve le ratio, en s'assurant que l'image tient
    // dans max_width x max_height (nearest neighbor pour garder des valeurs pures)
    let resized = original.resize(
        params.max_width.max(1),
        params.max_height.max(1),
        image::imageops::FilterType::Nearest,
    );

    let adjusted = resized.adjust_contrast(params.contrast);

    let (width, height) = adjusted.dimensions();
    let base64_png = encode_to_base64_png(&adjusted)?;

    drop(original_guard);
    *state.processed.lock().unwrap() = Some(adjusted);

    Ok(ImageInfo {
        base64_png,
        width,
        height,
    })
}

#[tauri::command]
pub fn get_pixel_data(state: State<'_, ImageState>) -> Result<PixelData, String> {
    let processed_guard = state.processed.lock().unwrap();
    let processed = processed_guard
        .as_ref()
        .ok_or_else(|| "Aucune image traitée disponible".to_string())?;

    let (width, height) = processed.dimensions();
    let rgba_img = processed.to_rgba8();
    let pixels = rgba_img.into_raw();

    Ok(PixelData {
        width,
        height,
        pixels,
    })
}