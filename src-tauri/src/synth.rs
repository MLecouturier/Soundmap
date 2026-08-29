use tauri::State;
use crate::midi::send_note_off;
use crate::state::{ImageState, Synth, SynthMode, SynthState, MidiState};

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
            synth.last_played_note = None;
            let mut conn_guard = midi_state.connection.lock().unwrap();

            // Éteindre immédiatement la note mono en cours, si elle sonne encore
            if synth.note_is_on {
                if let Some(conn) = conn_guard.as_mut() {
                    send_note_off(conn, synth.channel, synth.note);
                }
                synth.note_is_on = false;
            }

            // Éteindre les voix polyphoniques en cours
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
pub fn set_synth_threshold(
    id: u32,
    threshold: u8,
    state: State<SynthState>,
) -> Result<(), String> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.note_threshold = threshold.min(12);
            // On ne coupe pas la note en cours : le prochain tick réévaluera
            // normalement si un changement de note est nécessaire.
            Ok(())
        }
        None => Err(format!("Synthé {id} introuvable")),
    }
}

#[tauri::command]
pub fn set_synth_velocity_min(
    id: u32,
    velocity_min: u8,
    state: State<SynthState>,
) -> Result<(), String> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.velocity_min = velocity_min.min(126);
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
pub fn set_synth_mode(
    id: u32,
    mode: SynthMode,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), String> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            if synth.mode == mode {
                return Ok(());
            }
            // Éteindre toutes les notes en cours avant de changer de mode,
            // pour éviter des notes bloquées lors de la bascule.
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
        None => Err(format!("Synthé {id} introuvable")),
    }
}

#[tauri::command]
pub fn set_synth_hue_shift(id: u32, hue_shift: u16, state: State<SynthState>) -> Result<(), String> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.hue_shift = hue_shift.min(360);
            Ok(())
        }
        None => Err(format!("Synthé {id} introuvable")),
    }
}

#[tauri::command]
pub fn set_synth_channel_enabled(
    id: u32,
    channel_index: usize,
    enabled: bool,
    state: State<SynthState>,
    midi_state: State<MidiState>,
) -> Result<(), String> {
    if channel_index > 2 {
        return Err("Index de canal invalide (attendu 0, 1 ou 2)".to_string());
    }
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.channel_enabled[channel_index] = enabled;
            // Si on désactive un canal dont la voix sonne encore, l'éteindre immédiatement.
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