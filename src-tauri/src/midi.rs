use midir::{MidiOutput, MidiOutputConnection};
use tauri::State;

use crate::state::MidiState;

/// Tente de se connecter automatiquement au premier port de sortie MIDI disponible.
/// Ne fait rien si aucun port n'est trouvé (pas d'erreur bloquante : l'appli
/// doit rester utilisable même sans synthé MIDI branché).
pub fn auto_connect(state: &MidiState) {
    let midi_out = match MidiOutput::new("SoundMap") {
        Ok(m) => m,
        Err(e) => {
            eprintln!("Impossible d'initialiser MIDI: {e}");
            return;
        }
    };

    let ports = midi_out.ports();
    if ports.is_empty() {
        eprintln!("Aucun port MIDI de sortie détecté.");
        return;
    }

    let port = &ports[0];
    let port_name = midi_out
        .port_name(port)
        .unwrap_or_else(|_| "port inconnu".to_string());

    match midi_out.connect(port, "soundmap-out") {
        Ok(conn) => {
            println!("Connecté au port MIDI : {port_name}");
            *state.connection.lock().unwrap() = Some(conn);
        }
        Err(e) => {
            eprintln!("Échec de connexion au port MIDI '{port_name}': {e}");
        }
    }
}

/// Envoie un message Note On (0x90 | channel, note, velocity).
pub fn send_note_on(conn: &mut MidiOutputConnection, channel: u8, note: u8, velocity: u8) {
    let status = 0x90 | (channel & 0x0F);
    let _ = conn.send(&[status, note & 0x7F, velocity & 0x7F]);
}

/// Envoie un message Note Off (0x80 | channel, note, velocity=0).
pub fn send_note_off(conn: &mut MidiOutputConnection, channel: u8, note: u8) {
    let status = 0x80 | (channel & 0x0F);
    let _ = conn.send(&[status, note & 0x7F, 0]);
}

#[tauri::command]
pub fn is_midi_connected(state: State<'_, MidiState>) -> bool {
    state.connection.lock().unwrap().is_some()
}