use midir::{MidiOutput, MidiOutputConnection};
use serde::Serialize;
use tauri::State;

use crate::state::MidiState;

#[derive(Serialize, Clone)]
pub struct MidiPortInfo {
    pub index: usize,
    pub name: String,
}

/// Opens the connection to the given output port index, or None if the
/// port doesn't exist or can't be opened.
fn open_connection(port_index: usize) -> Option<MidiOutputConnection> {
    let midi_out = match MidiOutput::new("SoundMap") {
        Ok(m) => m,
        Err(e) => {
            eprintln!("Unable to initialize MIDI: {e}");
            return None;
        }
    };

    let ports = midi_out.ports();
    if ports.is_empty() {
        eprintln!("No MIDI output port detected.");
        return None;
    }

    let port = match ports.get(port_index) {
        Some(p) => p,
        None => {
            eprintln!("MIDI output port {port_index} not found.");
            return None;
        }
    };

    let port_name = midi_out
        .port_name(port)
        .unwrap_or_else(|_| "unknown port".to_string());

    match midi_out.connect(port, "soundmap-out") {
        Ok(conn) => {
            println!("Connected to MIDI port {port_index}: {port_name}");
            Some(conn)
        }
        Err(e) => {
            eprintln!("Failed to connect to MIDI port {port_index} ({port_name}): {e}");
            None
        }
    }
}

impl MidiState {
    /// Runs `f` with the open connection for the given port, opening it
    /// lazily on first use. Notes are silently dropped if the port is
    /// unavailable.
    fn with_connection(&self, port_index: usize, f: impl FnOnce(&mut MidiOutputConnection)) {
        let mut connections = self.connections.lock().unwrap();
        if !connections.contains_key(&port_index) {
            match open_connection(port_index) {
                Some(conn) => {
                    connections.insert(port_index, conn);
                }
                None => return,
            }
        }
        if let Some(conn) = connections.get_mut(&port_index) {
            f(conn);
        }
    }

    /// Sends a Note On message on the given output port (0x90 | channel).
    pub fn note_on(&self, port_index: usize, channel: u8, note: u8, velocity: u8) {
        self.with_connection(port_index, |conn| {
            send_note_on(conn, channel, note, velocity)
        });
    }

    /// Sends a Note Off message on the given output port (0x80 | channel).
    pub fn note_off(&self, port_index: usize, channel: u8, note: u8) {
        self.with_connection(port_index, |conn| send_note_off(conn, channel, note));
    }
}

/// Opens the first available MIDI output port eagerly, so the app is
/// usable right away. Other ports are opened lazily by the synths that
/// use them. Not a blocking error: the app must remain usable even
/// without a MIDI device connected.
pub fn auto_connect(state: &MidiState) {
    state.with_connection(0, |_| {});
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

/// Lists the available MIDI output ports. The index of each entry is the
/// port identifier to pass to `set_synth_midi_port`.
#[tauri::command]
pub fn list_midi_ports() -> Vec<MidiPortInfo> {
    let midi_out = match MidiOutput::new("SoundMap") {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    midi_out
        .ports()
        .iter()
        .enumerate()
        .map(|(index, port)| MidiPortInfo {
            index,
            name: midi_out
                .port_name(port)
                .unwrap_or_else(|_| format!("Port {index}")),
        })
        .collect()
}

#[tauri::command]
pub fn is_midi_connected(state: State<'_, MidiState>) -> bool {
    !state.connections.lock().unwrap().is_empty()
}
