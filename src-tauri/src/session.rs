use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use tauri::{AppHandle, State};

use crate::config::SynthTemplate;
use crate::error::{err, AppError};
use crate::image_processing::encode_to_base64_png;
use crate::state::{ImageState, MidiState, PixelZone, SynthState};

/// Frontend-owned state passed on save: metronome tempo, image processing
/// sliders, and the synths' display colors (in list order).
#[derive(Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub struct SessionUi {
    pub bpm: u32,
    pub grid_slider: u32,
    pub contrast: f32,
    pub brightness: i32,
    pub saturation: f32,
    pub posterize_levels: Option<u8>,
    pub synth_colors: Vec<SynthUiEntry>,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct SynthUiEntry {
    pub id: u32,
    pub color: String,
}

/// Image processing settings, saved as raw slider values so the restore
/// is exact (the column count itself is derived from the original image).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionImageSettings {
    pub grid_slider: u32,
    pub contrast: f32,
    pub brightness: i32,
    pub saturation: f32,
    pub posterize_levels: Option<u8>,
}

/// A synthesizer as stored in a session file: its identity, display color,
/// pixel zones, and settings (flattened SynthTemplate).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionSynth {
    pub id: u32,
    pub name: Option<String>,
    pub color: String,
    pub zones: Vec<PixelZone>,
    #[serde(flatten)]
    pub settings: SynthTemplate,
}

/// A self-contained work session: the original image (base64 PNG) plus
/// everything needed to restore the exact same state. `version` allows
/// future formats to stay backward-compatible.
#[derive(Serialize, Deserialize, Debug)]
pub struct SessionFile {
    pub version: u32,
    pub bpm: u32,
    pub image: SessionImage,
    pub image_settings: SessionImageSettings,
    pub synths: Vec<SessionSynth>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SessionImage {
    pub data: String, // base64 PNG of the original image
}

/// Payload returned by `load_session`, for the frontend to rebuild its UI.
#[derive(Serialize, Debug)]
pub struct LoadedSession {
    pub bpm: u32,
    pub image_base64: String,
    pub orig_width: u32,
    pub orig_height: u32,
    pub image_settings: SessionImageSettings,
    pub synths: Vec<SessionSynth>,
}

/// Saves the current work session to a `.soundmap` file picked through a
/// native save dialog. Canceling the dialog is not an error.
#[tauri::command]
pub async fn save_session(
    app: AppHandle,
    ui: SessionUi,
    image_state: State<'_, ImageState>,
    synth_state: State<'_, SynthState>,
) -> Result<(), AppError> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("SoundMap session", &["soundmap"])
        .blocking_save_file();

    let Some(path) = file_path else {
        return Ok(()); // canceled
    };
    let path = path
        .as_path()
        .ok_or_else(|| err("invalid_file_path"))?;

    // Encode the original image (the processed grid is re-derived from it)
    let image_guard = image_state.original.lock().unwrap();
    let Some(img) = image_guard.as_ref() else {
        return Err(err("no_image_loaded"));
    };
    let mut buffer = Vec::new();
    img.write_to(&mut Cursor::new(&mut buffer), ImageFormat::Png)
        .map_err(|e| err("png_encoding_error").with_param("details", e))?;
    let image = SessionImage {
        data: general_purpose::STANDARD.encode(&buffer),
    };

    // Synths in display order, as given by the frontend's color list
    let synths_guard = synth_state.synths.lock().unwrap();
    let synths = ui
        .synth_colors
        .iter()
        .filter_map(|entry| {
            let synth = synths_guard.get(&entry.id)?;
            Some(SessionSynth {
                id: entry.id,
                name: synth.name.clone(),
                color: entry.color.clone(),
                zones: synth.zones.clone(),
                settings: SynthTemplate::from_synth(synth),
            })
        })
        .collect();

    let file = SessionFile {
        version: 1,
        bpm: ui.bpm,
        image,
        image_settings: SessionImageSettings {
            grid_slider: ui.grid_slider,
            contrast: ui.contrast,
            brightness: ui.brightness,
            saturation: ui.saturation,
            posterize_levels: ui.posterize_levels,
        },
        synths,
    };

    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| err("session_write_error").with_param("details", e))?;
    fs::write(path, json)
        .map_err(|e| err("session_write_error").with_param("details", e))?;
    Ok(())
}

/// Loads a `.soundmap` file picked through a native open dialog and
/// reinstalls its whole state (image, synths) into the backend. Returns
/// the session's content for the frontend to rebuild its UI; `None` means
/// the dialog was canceled.
#[tauri::command]
pub async fn load_session(
    app: AppHandle,
    image_state: State<'_, ImageState>,
    synth_state: State<'_, SynthState>,
    midi_state: State<'_, MidiState>,
) -> Result<Option<LoadedSession>, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("SoundMap session", &["soundmap"])
        .blocking_pick_file();

    let Some(path) = file_path else {
        return Ok(None); // canceled
    };
    let path = path
        .as_path()
        .ok_or_else(|| err("invalid_file_path"))?;

    let content = fs::read_to_string(path)
        .map_err(|e| err("session_read_error").with_param("details", e))?;
    let file: SessionFile = serde_json::from_str(&content)
        .map_err(|e| err("session_parse_error").with_param("details", e))?;

    // Decode the original image
    let bytes = general_purpose::STANDARD
        .decode(&file.image.data)
        .map_err(|e| err("session_parse_error").with_param("details", e))?;
    let img: DynamicImage = image::load_from_memory(&bytes)
        .map_err(|e| err("session_parse_error").with_param("details", e))?;
    let (orig_width, orig_height) = img.dimensions();
    let image_base64 = encode_to_base64_png(&img)?;

    // Reinstall the image first, then the synths (same lock order as the
    // metronome thread: image, then synths)
    {
        let mut original = image_state.original.lock().unwrap();
        let mut processed = image_state.processed.lock().unwrap();
        *original = Some(img.clone());
        *processed = Some(img);
    }

    {
        let mut synths = synth_state.synths.lock().unwrap();
        // Turn off any sounding note before dropping the old synths
        for synth in synths.values_mut() {
            if synth.note_is_on {
                midi_state.note_off(synth.midi_port, synth.channel, synth.note);
                synth.note_is_on = false;
            }
            for voice in synth.poly_voices.iter_mut() {
                if voice.note_is_on {
                    midi_state.note_off(synth.midi_port, synth.channel, voice.note);
                    voice.note_is_on = false;
                }
            }
        }
        synths.clear();
        let mut max_id = 0;
        for entry in &file.synths {
            let mut synth = entry.settings.to_synth(entry.id);
            synth.name = entry.name.clone();
            synth.zones = entry.zones.clone();
            max_id = max_id.max(entry.id);
            synths.insert(entry.id, synth);
        }
        *synth_state.next_id.lock().unwrap() = max_id + 1;
    }

    Ok(Some(LoadedSession {
        bpm: file.bpm,
        image_base64,
        orig_width,
        orig_height,
        image_settings: file.image_settings,
        synths: file.synths,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{NoteLength, ReadingDirection, SynthMode};

    /// Round-trip check: a synth's full parameter set survives a
    /// save → file → load cycle.
    #[test]
    fn session_synth_round_trip() {
        // A synth with every parameter away from its default
        let mut synth = SynthTemplate::default().to_synth(7);
        synth.tempo_ratio = 0.5;
        synth.channel = 9;
        synth.midi_port = 2;
        synth.mode = SynthMode::Polyphonic;
        synth.loop_enabled = false;
        synth.back_and_forth = true;
        synth.reading_direction = ReadingDirection::BottomToTop;
        synth.brightness_min = 12;
        synth.brightness_max = 100;
        synth.velocity_min = 40;
        synth.hue_shift = 180;
        synth.channel_enabled = [true, false, true];
        synth.note_lengths = vec![NoteLength::Whole, NoteLength::Eighth];
        synth.note_length_reversed = true;
        synth.mono_note_range = [true, false, true];
        synth.voice_note_ranges = [[true, false, false], [false, true, false], [false, false, true]];

        let original = SessionSynth {
            id: 7,
            name: Some("Lead".into()),
            color: "#3498db".into(),
            zones: vec![PixelZone { x: 2, y: 3, w: 5, h: 4 }],
            settings: SynthTemplate::from_synth(&synth),
        };

        // Serialize to the session-file format, then back
        let json = serde_json::to_string(&original).unwrap();
        let restored: SessionSynth = serde_json::from_str(&json).unwrap();

        // Every parameter must survive
        assert_eq!(restored.id, original.id);
        assert_eq!(restored.name, original.name);
        assert_eq!(restored.color, original.color);
        assert_eq!(restored.zones, original.zones);
        let s = restored.settings.to_synth(7);
        assert_eq!(s.tempo_ratio, synth.tempo_ratio);
        assert_eq!(s.channel, synth.channel);
        assert_eq!(s.midi_port, synth.midi_port);
        assert_eq!(s.mode, synth.mode);
        assert_eq!(s.loop_enabled, synth.loop_enabled);
        assert_eq!(s.back_and_forth, synth.back_and_forth);
        assert_eq!(s.reading_direction, synth.reading_direction);
        assert_eq!(s.brightness_min, synth.brightness_min);
        assert_eq!(s.brightness_max, synth.brightness_max);
        assert_eq!(s.velocity_min, synth.velocity_min);
        assert_eq!(s.hue_shift, synth.hue_shift);
        assert_eq!(s.channel_enabled, synth.channel_enabled);
        assert_eq!(s.note_lengths, synth.note_lengths);
        assert_eq!(s.note_length_reversed, synth.note_length_reversed);
        assert_eq!(s.mono_note_range, synth.mono_note_range);
        assert_eq!(s.voice_note_ranges, synth.voice_note_ranges);
    }
}
