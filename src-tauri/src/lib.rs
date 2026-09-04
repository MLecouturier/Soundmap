pub mod error;
pub mod image_processing;
pub mod metronome;
pub mod midi;
pub mod state;
pub mod synth;

use tauri::Manager;
use metronome::MetronomeState;
use state::{ImageState, SynthState, MidiState};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ImageState::default())
        .manage(MetronomeState::default())
        .manage(SynthState::default())
        .manage(MidiState::default())
        .setup(|app| {
            let midi_state = app.state::<MidiState>();
            midi::auto_connect(&midi_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            image_processing::load_image,
            image_processing::apply_image_adjustments,
            image_processing::get_pixel_data,
            midi::list_midi_ports,
            metronome::start_metronome,
            metronome::stop_metronome,
            metronome::set_metronome_bpm,
            metronome::is_metronome_running,
            metronome::step_synth,
            synth::add_synth,
            synth::remove_synth,
            synth::start_synth,
            synth::stop_synth,
            synth::reset_synth_cursor,
            synth::is_synth_playing,
            synth::set_synth_channel,
            synth::set_synth_midi_port,
            synth::set_synth_threshold,
            synth::set_synth_tempo,
            synth::set_synth_brightness_range,
            synth::set_synth_velocity_min,
            synth::set_synth_loop,
            synth::set_synth_zones,
            synth::set_synth_mode,
            synth::set_synth_hue_shift,
            synth::set_synth_note_lengths,
            synth::set_synth_note_length_reversed,
            synth::set_synth_note_ranges,
            synth::set_synth_channel_enabled,
        ])
        .run(tauri::generate_context!())
        .expect("Error while launching the Tauri application");
}