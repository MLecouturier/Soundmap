pub mod image_processing;
pub mod metronome;
pub mod state;

use metronome::MetronomeState;
use state::ImageState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ImageState::default())
        .manage(MetronomeState::default())
        .invoke_handler(tauri::generate_handler![
            image_processing::load_image,
            image_processing::apply_image_adjustments,
            image_processing::get_pixel_data,
            metronome::start_metronome,
            metronome::stop_metronome,
            metronome::set_metronome_bpm,
            metronome::is_metronome_running,
        ])
        .run(tauri::generate_context!())
        .expect("Erreur lors du lancement de l'application Tauri");
}
