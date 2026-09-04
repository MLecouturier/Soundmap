use tauri::State;
use crate::error::{err, AppError};
use crate::midi::send_note_off;
use crate::state::{NoteLength, PixelZone, Synth, SynthMode, SynthState, MidiState};

// --- Existing SynthConfig / SynthEngine (pure pixel-processing logic) ---
// (unchanged, assumed to remain above or below in this file)

/// Builds the standard "synth not found" error, with the id as a parameter.
fn synth_not_found(id: u32) -> AppError {
    err("synth_not_found").with_param("id", id)
}

#[tauri::command]
pub fn add_synth(state: State<SynthState>) -> Result<u32, AppError> {
    let mut next_id = state.next_id.lock().unwrap();
    let id = *next_id;
    *next_id += 1;

    let synth = Synth::new(id);
    state.synths.lock().unwrap().insert(id, synth);

    Ok(id)
}

#[tauri::command]
pub fn remove_synth(id: u32, state: State<SynthState>) {
    state.synths.lock().unwrap().remove(&id);
}

#[tauri::command]
pub fn reset_synth_cursor(id: u32, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.cursor = 0;
            synth.end_pending = false;
            synth.tempo_accumulator = 0.0;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn start_synth(id: u32, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.playing = true;
            // A fresh start always replays from the beginning of the sequence
            // (e.g. after manually stepping to the end while paused)
            synth.end_pending = false;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn stop_synth(
    id: u32,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.playing = false;
            synth.last_played_note = None;
            synth.end_pending = false;
            synth.tempo_accumulator = 0.0;
            let mut conn_guard = midi_state.connection.lock().unwrap();

            // Immediately turn off the current mono note, if it is still sounding
            if synth.note_is_on {
                if let Some(conn) = conn_guard.as_mut() {
                    send_note_off(conn, synth.channel, synth.note);
                }
                synth.note_is_on = false;
            }

            // Turn off any currently sounding polyphonic voices
            for voice in synth.poly_voices.iter_mut() {
                if voice.note_is_on {
                    if let Some(conn) = conn_guard.as_mut() {
                        send_note_off(conn, synth.channel, voice.note);
                    }
                    voice.note_is_on = false;
                }
                voice.last_played_note = None;
            }
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn is_synth_playing(id: u32, state: State<SynthState>) -> bool {
    state
        .synths
        .lock()
        .unwrap()
        .get(&id)
        .map(|s| s.playing)
        .unwrap_or(false)
}

#[tauri::command]
pub fn set_synth_channel(id: u32, channel: u8, state: State<SynthState>) -> Result<(), AppError> {
    let clamped = channel.min(15);
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.channel = clamped;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_threshold(
    id: u32,
    threshold: u8,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.note_threshold = threshold.min(12);
            // The current note is not cut off: the next tick will evaluate
            // normally whether a note change is needed.
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_velocity_min(
    id: u32,
    velocity_min: u8,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.velocity_min = velocity_min.min(126);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_brightness_range(
    id: u32,
    brightness_min: u8,
    brightness_max: u8,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.brightness_min = brightness_min.min(127);
            synth.brightness_max = brightness_max.min(127);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_tempo(id: u32, tempo: f64, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.tempo_ratio = tempo.clamp(0.05, 4.0);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_loop(id: u32, loop_enabled: bool, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.loop_enabled = loop_enabled;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_mode(
    id: u32,
    mode: SynthMode,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            if synth.mode == mode {
                return Ok(());
            }
            // Turn off all currently sounding notes before switching modes,
            // to avoid stuck notes when toggling.
            let mut conn_guard = midi_state.connection.lock().unwrap();
            if synth.note_is_on {
                if let Some(conn) = conn_guard.as_mut() {
                    send_note_off(conn, synth.channel, synth.note);
                }
                synth.note_is_on = false;
            }
            for voice in synth.poly_voices.iter_mut() {
                if voice.note_is_on {
                    if let Some(conn) = conn_guard.as_mut() {
                        send_note_off(conn, synth.channel, voice.note);
                    }
                    voice.note_is_on = false;
                }
                voice.last_played_note = None;
            }
            synth.last_played_note = None;
            synth.mode = mode;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_note_lengths(
    id: u32,
    lengths: Vec<NoteLength>,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.note_lengths = lengths;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_note_length_reversed(
    id: u32,
    reversed: bool,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.note_length_reversed = reversed;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

/// Sets the MIDI note range filters: one triplet of toggles (bass, medium,
/// treble) for the monophonic note, and one per R/G/B voice in polyphonic
/// mode. All toggles off = full 0–127 range.
#[tauri::command]
pub fn set_synth_note_ranges(
    id: u32,
    mono: [bool; 3],
    voices: [[bool; 3]; 3],
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.mono_note_range = mono;
            synth.voice_note_ranges = voices;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_hue_shift(id: u32, hue_shift: u16, state: State<SynthState>) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.hue_shift = hue_shift.min(360);
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_channel_enabled(
    id: u32,
    channel_index: usize,
    enabled: bool,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), AppError> {
    if channel_index > 2 {
        return Err(err("invalid_channel_index"));
    }
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.channel_enabled[channel_index] = enabled;
            // If disabling a channel whose voice is still sounding, turn it off immediately.
            if !enabled {
                let voice = &mut synth.poly_voices[channel_index];
                if voice.note_is_on {
                    if let Some(conn) = midi_state.connection.lock().unwrap().as_mut() {
                        send_note_off(conn, synth.channel, voice.note);
                    }
                    voice.note_is_on = false;
                }
                voice.last_played_note = None;
            }
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}

#[tauri::command]
pub fn set_synth_zones(
    id: u32,
    zones: Vec<PixelZone>,
    state: State<SynthState>,
) -> Result<(), AppError> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.zones = zones;
            Ok(())
        }
        None => Err(synth_not_found(id)),
    }
}
