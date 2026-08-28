use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::midi::{send_note_off, send_note_on};
use crate::state::{ImageState, SynthState, MidiState};

pub struct MetronomeState {
    pub running: Arc<AtomicBool>,
    pub bpm: Arc<AtomicU32>,
}

impl Default for MetronomeState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            bpm: Arc::new(AtomicU32::new(120)),
        }
    }
}

#[tauri::command]
pub fn set_metronome_bpm(state: tauri::State<MetronomeState>, bpm: u32) {
    let clamped = bpm.clamp(20, 300);
    state.bpm.store(clamped, Ordering::Relaxed);
}

#[tauri::command]
pub fn start_metronome(app: AppHandle, state: tauri::State<MetronomeState>) {
    if state.running.load(Ordering::Relaxed) {
        return; // déjà en cours
    }
    state.running.store(true, Ordering::Relaxed);

    let running = state.running.clone();
    let bpm = state.bpm.clone();

    thread::spawn(move || {
        let mut beat_index: u64 = 0;
        while running.load(Ordering::Relaxed) {
            let current_bpm = bpm.load(Ordering::Relaxed).max(1);
            let interval_ms = 60_000u64 / current_bpm as u64;

            let _ = app.emit("metronome-tick", beat_index);

            // --- Avancement des synthés actifs sur l'image ---
            let image_state = app.state::<ImageState>();
            let synth_state = app.state::<SynthState>();

            if let Some(image) = image_state.processed.lock().unwrap().as_ref() {
                let (width, height) = (image.width() as usize, image.height() as usize);
                let total_pixels = width * height;

                let mut synths = synth_state.synths.lock().unwrap();
                for synth in synths.values_mut() {
                    if synth.playing && total_pixels > 0 {
                        synth.cursor = (synth.cursor + 1) % total_pixels;

                        let _ = app.emit("synth-pixel-tick", serde_json::json!({
                            "id": synth.id,
                            "cursor": synth.cursor,
                        }));
                    }
                }
            }

            // --- Note On pour chaque synthé actif ---
            {
                let synth_state = app.state::<SynthState>();
                let midi_state = app.state::<MidiState>();
                let synths = synth_state.synths.lock().unwrap();
                let mut conn_guard = midi_state.connection.lock().unwrap();

                if let Some(conn) = conn_guard.as_mut() {
                    for synth in synths.values().filter(|s| s.playing) {
                        send_note_on(conn, synth.channel, synth.note, 100);
                    }
                }
            }

            // --- Note Off après 80% de l'intervalle, pour détacher les notes ---
            let note_duration_ms = (interval_ms * 8) / 10;
            let app_off = app.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(note_duration_ms));

                let synth_state = app_off.state::<SynthState>();
                let midi_state = app_off.state::<MidiState>();
                let synths = synth_state.synths.lock().unwrap();
                let mut conn_guard = midi_state.connection.lock().unwrap();

                if let Some(conn) = conn_guard.as_mut() {
                    for synth in synths.values().filter(|s| s.playing) {
                        send_note_off(conn, synth.channel, synth.note);
                    }
                }
            });

            beat_index += 1;
            thread::sleep(Duration::from_millis(interval_ms));
        }
    });
}

#[tauri::command]
pub fn stop_metronome(state: tauri::State<MetronomeState>) {
    state.running.store(false, Ordering::Relaxed);
}

#[tauri::command]
pub fn is_metronome_running(state: tauri::State<MetronomeState>) -> bool {
    state.running.load(Ordering::Relaxed)
}