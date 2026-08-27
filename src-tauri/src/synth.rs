use tauri::State;
use crate::state::{Synth, SynthState};

// --- SynthConfig / SynthEngine existants (logique pure de traitement pixel) ---
// (inchangés, on suppose qu'ils restent au-dessus ou en dessous dans ce fichier)

#[tauri::command]
pub fn add_synth(state: State<SynthState>) -> u32 {
    let mut next_id = state.next_id.lock().unwrap();
    let id = *next_id;
    *next_id += 1;

    let synth = Synth::new(id);
    state.synths.lock().unwrap().insert(id, synth);

    id
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
pub fn stop_synth(id: u32, state: State<SynthState>) -> Result<(), String> {
    let mut synths = state.synths.lock().unwrap();
    match synths.get_mut(&id) {
        Some(synth) => {
            synth.playing = false;
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