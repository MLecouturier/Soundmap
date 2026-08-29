use crate::error::{err, AppError};
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

#[derive(Serialize)]
pub struct LoadedImageInfo {
    pub base64_png: String,
    pub orig_width: u32,
    pub orig_height: u32,
}

#[derive(Serialize)]
pub struct AdjustedImageInfo {
    pub base64_png: String,
    pub width: u32,
    pub height: u32,
    pub cell_count: u32,
}

#[derive(Deserialize)]
pub struct AdjustmentParams {
    pub grid_width: u32,
    pub grid_height: Option<u32>, // always None for now: ratio is deduced
    pub contrast: f32,
    pub brightness: i32,
    pub grayscale: bool,
    pub posterize_levels: Option<u8>,
}

#[derive(Serialize)]
pub struct PixelData {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>, // flat RGBA: r,g,b,a, r,g,b,a, ...
}

fn encode_to_base64_png(img: &DynamicImage) -> Result<String, AppError> {
    let mut buffer = Cursor::new(Vec::new());
    img.write_to(&mut buffer, ImageFormat::Png)
        .map_err(|e| err("png_encoding_error").with_param("details", e))?;
    Ok(general_purpose::STANDARD.encode(buffer.into_inner()))
}

#[tauri::command]
pub async fn load_image(
    app_handle: tauri::AppHandle,
    state: State<'_, ImageState>,
) -> Result<LoadedImageInfo, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app_handle
        .dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg", "bmp", "gif"])
        .blocking_pick_file();

    let path = file_path.ok_or_else(|| err("no_file_selected"))?;

    let path_buf = path
        .as_path()
        .ok_or_else(|| err("invalid_file_path"))?;

    let img = image::open(path_buf)
        .map_err(|e| err("image_load_error").with_param("details", e))?;

    let (width, height) = img.dimensions();
    let base64_png = encode_to_base64_png(&img)?;

    *state.original.lock().unwrap() = Some(img.clone());
    *state.processed.lock().unwrap() = Some(img);

    Ok(LoadedImageInfo {
        base64_png,
        orig_width: width,
        orig_height: height,
    })
}

#[tauri::command]
pub fn apply_image_adjustments(
    state: State<'_, ImageState>,
    params: AdjustmentParams,
) -> Result<AdjustedImageInfo, AppError> {
    let original_guard = state.original.lock().unwrap();
    let original = original_guard
        .as_ref()
        .ok_or_else(|| err("no_image_loaded"))?;

    let (orig_w, orig_h) = original.dimensions();

    // --- Actual downsampling: grid_width becomes the number of columns/notes ---
    // The ratio is always deduced from the original image (no independent grid_height).
    let target_w = params.grid_width.max(1);
    let target_h = ((orig_h as f64) * (target_w as f64) / (orig_w as f64))
        .round()
        .max(1.0) as u32;

    let mut img = original.resize_exact(
        target_w,
        target_h,
        image::imageops::FilterType::Nearest,
    );

    // --- Adjustments ---
    if params.grayscale {
        img = DynamicImage::ImageLuma8(img.to_luma8()).into();
        // convert back to RGBA to stay consistent with the rest of the pipeline
        img = DynamicImage::ImageRgba8(img.to_rgba8());
    }

    if params.contrast != 0.0 {
        img = img.adjust_contrast(params.contrast);
    }

    if params.brightness != 0 {
        img = img.brighten(params.brightness);
    }

    if let Some(levels) = params.posterize_levels {
        if levels >= 2 {
            img = posterize(&img, levels);
        }
    }

    let (width, height) = img.dimensions();
    let base64_png = encode_to_base64_png(&img)?;
    let cell_count = width * height;

    drop(original_guard);
    *state.processed.lock().unwrap() = Some(img);

    Ok(AdjustedImageInfo {
        base64_png,
        width,
        height,
        cell_count,
    })
}

/// Reduces each RGB channel to `levels` distinct steps (classic posterize).
fn posterize(img: &DynamicImage, levels: u8) -> DynamicImage {
    let levels = levels.max(2) as f32;
    let step = 255.0 / (levels - 1.0);

    let mut rgba = img.to_rgba8();
    for pixel in rgba.pixels_mut() {
        for channel in 0..3 {
            let v = pixel[channel] as f32;
            let posterized = ((v / step).round() * step).clamp(0.0, 255.0);
            pixel[channel] = posterized as u8;
        }
    }
    DynamicImage::ImageRgba8(rgba)
}

#[tauri::command]
pub fn get_pixel_data(state: State<'_, ImageState>) -> Result<PixelData, AppError> {
    let processed_guard = state.processed.lock().unwrap();
    let processed = processed_guard
        .as_ref()
        .ok_or_else(|| err("no_processed_image"))?;

    let (width, height) = processed.dimensions();
    let rgba_img = processed.to_rgba8();
    let pixels = rgba_img.into_raw();

    Ok(PixelData {
        width,
        height,
        pixels,
    })
}