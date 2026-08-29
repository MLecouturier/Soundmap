use midir::{MidiOutput, MidiOutputConnection};
use tauri::State;

use crate::state::MidiState;

/// Tries to automatically connect to the first available MIDI output port.
/// Does nothing if no port is found (not a blocking error: the app must
/// remain usable even without a MIDI device connected).
pub fn auto_connect(state: &MidiState) {
    let midi_out = match MidiOutput::new("SoundMap") {
        Ok(m) => m,
        Err(e) => {
            eprintln!("Unable to initialize MIDI: {e}");
            return;
        }
    };

    let ports = midi_out.ports();
    if ports.is_empty() {
        eprintln!("No MIDI output port detected.");
        return;
    }

    let port = &ports[0];
    let port_name = midi_out
        .port_name(port)
        .unwrap_or_else(|_| "unknown port".to_string());

    match midi_out.connect(port, "soundmap-out") {
        Ok(conn) => {
            println!("Connected to MIDI port: {port_name}");
            *state.connection.lock().unwrap() = Some(conn);
        }
        Err(e) => {
            eprintln!("Failed to connect to MIDI port '{port_name}': {e}");
        }
    }
}

/// Sends a Note On message (0x90 | channel, note, velocity).
pub fn send_note_on(conn: &mut MidiOutputConnection, channel: u8, note: u8, velocity: u8) {
    let status = 0x90 | (channel & 0x0F);
    let _ = conn.send(&[status, note & 0x7F, velocity & 0x7F]);
}

/// Sends a Note Off message (0x80 | channel, note, velocity=0).
pub fn send_note_off(conn: &mut MidiOutputConnection, channel: u8, note: u8) {
    let status = 0x80 | (channel & 0x0F);
    let _ = conn.send(&[status, note & 0x7F, 0]);
}

#[tauri::command]
pub fn is_midi_connected(state: State<'_, MidiState>) -> bool {
    state.connection.lock().unwrap().is_some()
}