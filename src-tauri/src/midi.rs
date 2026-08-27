use midir::{MidiOutput, MidiOutputConnection};
use std::sync::Mutex;

/// Enveloppe autour d'une connexion MIDI de sortie, thread-safe.
pub struct MidiSender {
    conn: Mutex<Option<MidiOutputConnection>>,
}

impl MidiSender {
    pub fn new() -> Self {
        Self { conn: Mutex::new(None) }
    }

    pub fn list_ports() -> Result<Vec<String>, String> {
        let midi_out = MidiOutput::new("Soundmap").map_err(|e| e.to_string())?;
        Ok(midi_out
            .ports()
            .iter()
            .filter_map(|p| midi_out.port_name(p).ok())
            .collect())
    }

    pub fn connect(&self, port_index: usize) -> Result<(), String> {
        let midi_out = MidiOutput::new("Soundmap").map_err(|e| e.to_string())?;
        let ports = midi_out.ports();
        let port = ports.get(port_index).ok_or("Port MIDI introuvable")?;
        let connection = midi_out
            .connect(port, "soundmap-output")
            .map_err(|e| e.to_string())?;
        *self.conn.lock().unwrap() = Some(connection);
        Ok(())
    }

    pub fn disconnect(&self) {
        *self.conn.lock().unwrap() = None;
    }

    pub fn is_connected(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }

    pub fn note_on(&self, channel: u8, note: u8, velocity: u8) -> Result<(), String> {
        self.send(&[0x90 | (channel & 0x0F), note, velocity])
    }

    pub fn note_off(&self, channel: u8, note: u8) -> Result<(), String> {
        self.send(&[0x80 | (channel & 0x0F), note, 0])
    }

    fn send(&self, bytes: &[u8]) -> Result<(), String> {
        let mut guard = self.conn.lock().unwrap();
        match guard.as_mut() {
            Some(conn) => conn.send(bytes).map_err(|e| e.to_string()),
            None => Err("Aucune connexion MIDI ouverte".to_string()),
        }
    }
}

impl Default for MidiSender {
    fn default() -> Self {
        Self::new()
    }
}

// ---- Commandes Tauri ----
pub mod commands {
    use super::MidiSender;
    use crate::state::MidiState;

    #[tauri::command]
    pub fn list_midi_ports() -> Result<Vec<String>, String> {
        MidiSender::list_ports()
    }

    #[tauri::command]
    pub fn connect_midi_port(state: tauri::State<MidiState>, port_index: usize) -> Result<(), String> {
        state.sender.connect(port_index)
    }

    #[tauri::command]
    pub fn disconnect_midi_port(state: tauri::State<MidiState>) {
        state.sender.disconnect();
    }

    #[tauri::command]
    pub fn is_midi_connected(state: tauri::State<MidiState>) -> bool {
        state.sender.is_connected()
    }
}