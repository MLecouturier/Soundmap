use tauri::State;
use crate::midi::send_note_off;
use crate::state::{ImageState, Synth, SynthState, MidiState};

// --- SynthConfig / SynthEngine existants (logique pure de traitement pixel) ---
// (inchangés, on suppose qu'ils restent au-dessus ou en dessous dans ce fichier)

#[tauri::command]
pub fn add_synth(
    image_state: State<ImageState>,
    state: State<SynthState>,
) -> Result<u32, String> {
    let has_image = image_state.original.lock().unwrap().is_some();
    if !has_image {
        return Err("Veuillez charger une image avant d'ajouter un synthétiseur.".to_string());
    }

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
pub fn start_synth(id: u32, state: State<SynthState>) -> Result<(), String> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.playing = true;
            Ok(())
        }
        None => Err(format!("Synthé {id} introuvable")),
    }
}

#[tauri::command]
pub fn stop_synth(
    id: u32,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), String> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.playing = false;
            // Éteindre immédiatement la note en cours
            if let Some(conn) = midi_state.connection.lock().unwrap().as_mut() {
                send_note_off(conn, synth.channel, synth.note);
            }
            Ok(())
        }
        None => Err(format!("Synthé {id} introuvable")),
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
pub fn set_synth_channel(id: u32, channel: u8, state: State<SynthState>) -> Result<(), String> {
    let clamped = channel.min(15);
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.channel = clamped;
            Ok(())
        }
        None => Err(format!("Synthé {id} introuvable")),
    }
}

#[tauri::command]
pub fn set_synth_brightness_range(
    id: u32,
    brightness_min: u8,
    brightness_max: u8,
    state: State<SynthState>,
) -> Result<(), String> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.brightness_min = brightness_min.min(127);
            synth.brightness_max = brightness_max.min(127);
            Ok(())
        }
        None => Err(format!("Synthé {id} introuvable")),
    }
}

#[tauri::command]
pub fn set_synth_loop(id: u32, loop_enabled: bool, state: State<SynthState>) -> Result<(), String> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.loop_enabled = loop_enabled;
            Ok(())
        }
        None => Err(format!("Synthé {id} introuvable")),
    }
}

#[tauri::command]
pub fn set_synth_range(
    id: u32,
    pixel_start: usize,
    pixel_end: usize,
    state: State<SynthState>,
) -> Result<(), String> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.pixel_start = pixel_start;
            synth.pixel_end = pixel_end;
            // Replacer le curseur dans le range si nécessaire
            if synth.cursor < pixel_start {
                synth.cursor = pixel_start;
            } else if pixel_end > 0 && synth.cursor > pixel_end {
                synth.cursor = pixel_start;
            }
            Ok(())
        }
        None => Err(format!("Synthé {id} introuvable")),
    }
}