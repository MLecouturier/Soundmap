use crate::config::ConfigState;
use crate::error::{err, AppError};
use crate::state::ImageState;
use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use tauri::State;

#[derive(Serialize)]
pub struct LoadedImageInfo {
    pub base64_png: String,
    pub orig_width: u32,
    pub orig_height: u32,
}

#[derive(Deserialize)]
pub struct AdjustmentParams {
    pub grid_width: u32,
    pub grid_height: Option<u32>, // always None for now: ratio is deduced
    pub contrast: f32,
    pub brightness: i32,
    pub saturation: f32,
    pub posterize_levels: Option<u8>,
}

pub(crate) fn encode_to_base64_png(img: &DynamicImage) -> Result<String, AppError> {
    let mut buffer = Cursor::new(Vec::new());
    img.write_to(&mut buffer, ImageFormat::Png)
        .map_err(|e| err("png_encoding_error").with_param("details", e))?;
    Ok(general_purpose::STANDARD.encode(buffer.into_inner()))
}

/// Packs an image into the raw IPC format consumed by the frontend:
/// an 8-byte header (width and height as little-endian u32) followed by
/// the flat RGBA bytes. Transferred as binary (no PNG encoding, no
/// base64, no JSON), then painted directly on a canvas.
fn rgba_ipc_response(img: &DynamicImage) -> tauri::ipc::Response {
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    let mut bytes = Vec::with_capacity(8 + rgba.as_raw().len());
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    bytes.extend_from_slice(rgba.as_raw());
    tauri::ipc::Response::new(bytes)
}

#[tauri::command]
pub async fn load_image(
    app_handle: tauri::AppHandle,
    state: State<'_, ImageState>,
    config_state: State<'_, ConfigState>,
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

    let mut img = image::open(path_buf)
        .map_err(|e| err("image_load_error").with_param("details", e))?;

    // Downscale oversized originals so the app stays responsive
    let max_size = config_state.config.lock().unwrap().max_image_size;
    if max_size > 0 {
        let (w, h) = img.dimensions();
        if w.max(h) > max_size {
            img = img.resize(max_size, max_size, image::imageops::FilterType::Lanczos3);
        }
    }

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

#[derive(Deserialize)]
pub struct TransformParams {
    pub rotation: f32,      // fine rotation in degrees (positive = clockwise)
    pub perspective_v: f32, // vertical keystone, fraction of the width, in (-1, 1)
    pub perspective_h: f32, // horizontal keystone, fraction of the height, in (-1, 1)
}

/// Samples `src` at fractional coordinates with bilinear interpolation.
/// Coordinates outside the source yield fully transparent pixels.
fn sample_bilinear(src: &image::RgbaImage, x: f32, y: f32) -> image::Rgba<u8> {
    let (w, h) = src.dimensions();
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || x >= w as f32 || y >= h as f32 {
        return image::Rgba([0, 0, 0, 0]);
    }
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    let fx = x - x0 as f32;
    let fy = y - y0 as f32;

    let p00 = src.get_pixel(x0, y0);
    let p10 = src.get_pixel(x1, y0);
    let p01 = src.get_pixel(x0, y1);
    let p11 = src.get_pixel(x1, y1);

    // Bilinear interpolation per channel (alpha included)
    let mut out = [0u8; 4];
    for c in 0..4 {
        let top = p00[c] as f32 * (1.0 - fx) + p10[c] as f32 * fx;
        let bottom = p01[c] as f32 * (1.0 - fx) + p11[c] as f32 * fx;
        out[c] = (top * (1.0 - fy) + bottom * fy).round() as u8;
    }
    image::Rgba(out)
}

/// Rotates `img` by `angle_degrees` about its center (positive = clockwise),
/// expanding the canvas so the whole image fits; the exposed corners are
/// transparent. Inverse mapping with bilinear sampling.
fn rotate_fine(img: &DynamicImage, angle_degrees: f32) -> DynamicImage {
    if angle_degrees == 0.0 {
        return img.clone();
    }

    let src = img.to_rgba8();
    let (w, h) = src.dimensions();
    let (wf, hf) = (w as f32, h as f32);
    let theta = angle_degrees.to_radians();
    let (sin, cos) = theta.sin_cos();

    let out_w = ((wf * cos).abs() + (hf * sin).abs()).round().max(1.0) as u32;
    let out_h = ((wf * sin).abs() + (hf * cos).abs()).round().max(1.0) as u32;
    let (cx_out, cy_out) = (out_w as f32 / 2.0, out_h as f32 / 2.0);
    let (cx_in, cy_in) = (wf / 2.0, hf / 2.0);

    let mut out = image::RgbaImage::new(out_w, out_h);
    for y in 0..out_h {
        for x in 0..out_w {
            // Dest pixel center, relative to the canvas center
            let dx = x as f32 + 0.5 - cx_out;
            let dy = y as f32 + 0.5 - cy_out;
            // Inverse rotation (transposed matrix of the clockwise forward map)
            let sx = dx * cos + dy * sin + cx_in - 0.5;
            let sy = -dx * sin + dy * cos + cy_in - 0.5;
            out.put_pixel(x, y, sample_bilinear(&src, sx, sy));
        }
    }
    DynamicImage::ImageRgba8(out)
}

/// Projective transform, applied as (x, y, 1) * coeffs (homogeneous divide).
struct Homography {
    a: f32, b: f32, c: f32,
    d: f32, e: f32, f: f32,
    g: f32, k: f32,
}

impl Homography {
    fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        let denom = self.g * x + self.k * y + 1.0;
        if !denom.is_finite() || denom.abs() < 1e-9 {
            return (f32::NAN, f32::NAN);
        }
        (
            (self.a * x + self.b * y + self.c) / denom,
            (self.d * x + self.e * y + self.f) / denom,
        )
    }
}

/// Solves the 8x8 linear system `m * x = v` via Gaussian elimination with
/// partial pivoting. Returns zeroed coefficients on a (near-)singular system.
fn solve_linear8(mut m: [[f32; 8]; 8], mut v: [f32; 8]) -> [f32; 8] {
    for col in 0..8 {
        let mut pivot = col;
        for r in (col + 1)..8 {
            if m[r][col].abs() > m[pivot][col].abs() {
                pivot = r;
            }
        }
        m.swap(col, pivot);
        v.swap(col, pivot);

        let d = m[col][col];
        if d.abs() < 1e-9 {
            return [0.0; 8];
        }
        for r in (col + 1)..8 {
            let factor = m[r][col] / d;
            let pivot_row = m[col];
            for (val, pv) in m[r][col..8].iter_mut().zip(pivot_row[col..8].iter()) {
                *val -= factor * pv;
            }
            v[r] -= factor * v[col];
        }
    }

    let mut x = [0.0f32; 8];
    for r in (0..8).rev() {
        let mut acc = v[r];
        for (val, sv) in m[r][(r + 1)..8].iter().zip(x[(r + 1)..8].iter()) {
            acc -= val * sv;
        }
        x[r] = acc / m[r][r];
    }
    x
}

/// Builds the homography mapping the rectangle (0,0)-(dst_w, dst_h) onto the
/// four quad corners (top-left, top-right, bottom-right, bottom-left).
fn homography_from_corners(
    dst_w: u32,
    dst_h: u32,
    quad: [(f32, f32); 4],
) -> Homography {
    // Dest corners in the same order as the quad
    let dst = [
        (0.0, 0.0),
        (dst_w as f32, 0.0),
        (dst_w as f32, dst_h as f32),
        (0.0, dst_h as f32),
    ];

    // System rows for the unknowns [a, b, c, d, e, f, g, k], with the
    // convention X = (a x + b y + c) / (g x + k y + 1), Y = (d x + e y + f) / (g x + k y + 1)
    let mut m = [[0.0f32; 8]; 8];
    let mut v = [0.0f32; 8];
    for i in 0..4 {
        let (x, y) = dst[i];
        let (qx, qy) = quad[i];
        let row = i * 2;
        m[row] = [x, y, 1.0, 0.0, 0.0, 0.0, -qx * x, -qx * y];
        v[row] = qx;
        m[row + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -qy * x, -qy * y];
        v[row + 1] = qy;
    }

    let [a, b, c, d, e, f, g, k] = solve_linear8(m, v);
    Homography { a, b, c, d, e, f, g, k }
}

/// Extracts a symmetric trapezoid (keystone correction) from `img` into a
/// rectangle of the same dimensions. `v` and `h` are keystone amounts in
/// (-1, 1): `v > 0` narrows the top edge, `v < 0` the bottom one; `h > 0`
/// shortens the left edge, `h < 0` the right one. The trapezoid is always
/// inscribed in the source (the widest edges span the full canvas).
/// Inverse-mapped with bilinear sampling.
fn perspective_correct(img: &DynamicImage, v: f32, h: f32) -> DynamicImage {
    let src = img.to_rgba8();
    let (w, h_px) = src.dimensions();
    let v = v.clamp(-0.95, 0.95);
    let h = h.clamp(-0.95, 0.95);
    let (wf, hf) = (w as f32, h_px as f32);

    // Extents of the 4 edges of the trapezoid: the edge matching the
    // keystone direction shrinks, the opposite one spans the full canvas
    let tw = wf * (1.0 - v.max(0.0));  // top edge width
    let bw = wf * (1.0 - (-v).max(0.0)); // bottom edge width
    let lh = hf * (1.0 - h.max(0.0));  // left edge height
    let rh = hf * (1.0 - (-h).max(0.0)); // right edge height

    // Source quadrilateral, symmetric about the canvas center
    let quad = [
        ((wf - tw) / 2.0, (hf - lh) / 2.0), // top-left
        ((wf + tw) / 2.0, (hf - rh) / 2.0), // top-right
        ((wf + bw) / 2.0, (hf + rh) / 2.0), // bottom-right
        ((wf - bw) / 2.0, (hf + lh) / 2.0), // bottom-left
    ];

    let out_w = tw.max(bw).round().max(1.0) as u32;
    let out_h = lh.max(rh).round().max(1.0) as u32;
    let homography = homography_from_corners(out_w, out_h, quad);

    let mut out = image::RgbaImage::new(out_w, out_h);
    for y in 0..out_h {
        for x in 0..out_w {
            // The homography maps corner-space to corner-space: feeding the
            // dest pixel center (x+0.5, y+0.5) yields the source sampling
            // point directly.
            let (sx, sy) = homography.apply(x as f32 + 0.5, y as f32 + 0.5);
            out.put_pixel(x, y, sample_bilinear(&src, sx, sy));
        }
    }
    DynamicImage::ImageRgba8(out)
}

/// Applies the transform chain to a copy of `img`: fine rotation first
/// (canvas expanded, transparent corners), then keystone extraction.
fn apply_transform(img: &DynamicImage, params: &TransformParams) -> DynamicImage {
    let mut out = img.clone();
    if params.rotation != 0.0 {
        out = rotate_fine(&out, params.rotation);
    }
    if params.perspective_v != 0.0 || params.perspective_h != 0.0 {
        out = perspective_correct(&out, params.perspective_v, params.perspective_h);
    }
    out
}

/// Crops the stored original image in place, in original pixel coordinates.
#[tauri::command]
pub fn crop_image(
    state: State<'_, ImageState>,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<LoadedImageInfo, AppError> {
    let mut original_guard = state.original.lock().unwrap();
    let original = original_guard
        .as_mut()
        .ok_or_else(|| err("no_image_loaded"))?;

    let (ow, oh) = original.dimensions();
    let x = x.min(ow.saturating_sub(1));
    let y = y.min(oh.saturating_sub(1));
    let width = width.clamp(1, ow - x);
    let height = height.clamp(1, oh - y);

    let cropped = image::imageops::crop_imm(original, x, y, width, height).to_image();
    let img = DynamicImage::ImageRgba8(cropped);
    *original = img.clone();
    drop(original_guard);

    let (w, h) = img.dimensions();
    let base64_png = encode_to_base64_png(&img)?;
    *state.processed.lock().unwrap() = Some(img);

    Ok(LoadedImageInfo {
        base64_png,
        orig_width: w,
        orig_height: h,
    })
}

/// Computes the transformed image for preview purposes, without touching
/// the stored state.
#[tauri::command]
pub fn preview_image_transform(
    state: State<'_, ImageState>,
    params: TransformParams,
) -> Result<tauri::ipc::Response, AppError> {
    let guard = state.original.lock().unwrap();
    let original = guard
        .as_ref()
        .ok_or_else(|| err("no_image_loaded"))?;

    let img = apply_transform(original, &params);
    Ok(rgba_ipc_response(&img))
}

/// Applies the transform chain to the stored original image, in place.
#[tauri::command]
pub fn apply_image_transform(
    state: State<'_, ImageState>,
    params: TransformParams,
) -> Result<LoadedImageInfo, AppError> {
    let mut original_guard = state.original.lock().unwrap();
    let original = original_guard
        .as_mut()
        .ok_or_else(|| err("no_image_loaded"))?;

    let img = apply_transform(original, &params);
    *original = img.clone();
    drop(original_guard);

    let (width, height) = img.dimensions();
    let base64_png = encode_to_base64_png(&img)?;
    *state.processed.lock().unwrap() = Some(img);

    Ok(LoadedImageInfo {
        base64_png,
        orig_width: width,
        orig_height: height,
    })
}

/// Rotates the loaded original image by 90° clockwise, in place: the
/// stored original becomes the rotated image, so subsequent adjustments
/// (and the grid deduced from its ratio) apply to the rotated version.
#[tauri::command]
pub fn rotate_image(state: State<'_, ImageState>) -> Result<LoadedImageInfo, AppError> {
    let mut original_guard = state.original.lock().unwrap();
    let original = original_guard
        .as_mut()
        .ok_or_else(|| err("no_image_loaded"))?;

    *original = original.rotate90();
    let img = original.clone();
    drop(original_guard);

    let (width, height) = img.dimensions();
    let base64_png = encode_to_base64_png(&img)?;
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
) -> Result<tauri::ipc::Response, AppError> {
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
    if params.saturation != 0.0 {
        img = adjust_saturation(&img, params.saturation);
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

    let response = rgba_ipc_response(&img);

    drop(original_guard);
    *state.processed.lock().unwrap() = Some(img);

    Ok(response)
}

/// Adjusts color saturation. `factor` is a percentage in [-100, 100]:
/// -100 fully desaturates (grayscale), 0 is a no-op, positive values
/// amplify the chroma relative to each pixel's luma.
fn adjust_saturation(img: &DynamicImage, factor: f32) -> DynamicImage {
    let scale = 1.0 + (factor / 100.0).max(-1.0);

    let mut rgba = img.to_rgba8();
    for pixel in rgba.pixels_mut() {
        let luma = pixel_luma8(pixel) as f32;
        for channel in 0..3 {
            let v = pixel[channel] as f32;
            let saturated = (luma + (v - luma) * scale).clamp(0.0, 255.0);
            pixel[channel] = saturated as u8;
        }
    }
    DynamicImage::ImageRgba8(rgba)
}

fn pixel_luma8(pixel: &image::Rgba<u8>) -> u8 {
    // Rec. 601 luma, same weights as image::Luma conversion
    let r = pixel[0] as u32;
    let g = pixel[1] as u32;
    let b = pixel[2] as u32;
    ((r * 299 + g * 587 + b * 114) / 1000) as u8
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn homography_maps_the_dest_corners_onto_the_quad() {
        let quad = [(10.0, 20.0), (110.0, 15.0), (105.0, 215.0), (5.0, 210.0)];
        let h = homography_from_corners(100, 200, quad);
        let eps = 1e-3;

        let tl = h.apply(0.0, 0.0);
        let tr = h.apply(100.0, 0.0);
        let br = h.apply(100.0, 200.0);
        let bl = h.apply(0.0, 200.0);

        assert!((tl.0 - quad[0].0).abs() < eps && (tl.1 - quad[0].1).abs() < eps);
        assert!((tr.0 - quad[1].0).abs() < eps && (tr.1 - quad[1].1).abs() < eps);
        assert!((br.0 - quad[2].0).abs() < eps && (br.1 - quad[2].1).abs() < eps);
        assert!((bl.0 - quad[3].0).abs() < eps && (bl.1 - quad[3].1).abs() < eps);
    }

    #[test]
    fn perspective_keeps_the_wider_edge_intact() {
        // 100x100 solid image, vertical keystone: bottom wider than top
        let img = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(100, 100, image::Rgba([200, 150, 100, 255])));
        let out = perspective_correct(&img, 0.2, 0.0);
        assert_eq!(out.dimensions(), (100, 100));

        // The bottom edge of the trapezoid (full width) must be kept: the
        // bottom row of the output samples the bottom row of the source
        let rgba = out.to_rgba8();
        assert_eq!(rgba.get_pixel(0, 99), &image::Rgba([200, 150, 100, 255]));
        assert_eq!(rgba.get_pixel(99, 99), &image::Rgba([200, 150, 100, 255]));
        // The top row samples the (narrower) top edge, still inside the source
        assert_eq!(rgba.get_pixel(50, 0), &image::Rgba([200, 150, 100, 255]));
    }

    #[test]
    fn rotate_fine_expands_the_canvas_and_keeps_center_pixel() {
        // 90° rotation of a 100x50 image swaps the dimensions
        let img = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(100, 50, image::Rgba([120, 130, 140, 255])));
        let out = rotate_fine(&img, 90.0);
        assert_eq!(out.dimensions(), (50, 100));
        assert_eq!(out.to_rgba8().get_pixel(25, 50), &image::Rgba([120, 130, 140, 255]));

        // A small angle only slightly expands the canvas
        let out = rotate_fine(&img, 10.0);
        let (w, h) = out.dimensions();
        assert!(w >= 100 && w < 130, "unexpected width {w}");
        assert!(h >= 50 && h < 130, "unexpected height {h}");
    }

    #[test]
    fn sample_bilinear_interpolates_and_fills_outside() {
        let mut src = image::RgbaImage::new(2, 2);
        src.put_pixel(0, 0, image::Rgba([0, 0, 0, 255]));
        src.put_pixel(1, 0, image::Rgba([100, 100, 100, 255]));
        src.put_pixel(0, 1, image::Rgba([200, 200, 200, 255]));
        src.put_pixel(1, 1, image::Rgba([255, 255, 255, 255]));

        let mid = sample_bilinear(&src, 0.5, 0.5);
        assert!((mid[0] as i32 - 139).abs() <= 1);

        let outside = sample_bilinear(&src, 5.0, 5.0);
        assert_eq!(outside, image::Rgba([0, 0, 0, 0]));
    }
}

