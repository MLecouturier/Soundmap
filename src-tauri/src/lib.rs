pub mod image_processing;
pub mod metronome;
pub mod state;
pub mod synth;

use metronome::MetronomeState;
use state::{ImageState, SynthState};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ImageState::default())
        .manage(MetronomeState::default())
        .manage(SynthState::default())
        .invoke_handler(tauri::generate_handler![
            image_processing::load_image,
            image_processing::apply_image_adjustments,
            image_processing::get_pixel_data,
            metronome::start_metronome,
            metronome::stop_metronome,
            metronome::set_metronome_bpm,
            metronome::is_metronome_running,
            synth::add_synth,
            synth::remove_synth,
            synth::start_synth,
            synth::stop_synth,
            synth::is_synth_playing,
        ])
        .run(tauri::generate_context!())
        .expect("Erreur lors du lancement de l'application Tauri");
}
