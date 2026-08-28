use image::DynamicImage;
use midir::MidiOutputConnection;
use std::collections::HashMap;
use std::sync::Mutex;

pub struct ImageState {
    pub original: Mutex<Option<DynamicImage>>,
    pub processed: Mutex<Option<DynamicImage>>,
}

impl Default for ImageState {
    fn default() -> Self {
        Self {
            original: Mutex::new(None),
            processed: Mutex::new(None),
        }
    }
}

/// État d'un synthétiseur individuel.
#[derive(Clone)]
pub struct Synth {
    pub id: u32,
    pub playing: bool,
    pub cursor: usize,      // index du pixel courant (0..width*height)
    pub note: u8,           // note MIDI fixe pour l'instant : LA4 = 69
    pub channel: u8,        // canal MIDI 0-15
    pub pixel_start: usize,   // pixel d'entrée (inclusif)
    pub pixel_end: usize,     // pixel de sortie (inclusif, 0 = jusqu'à la fin)
    pub loop_enabled: bool,   // lecture en boucle ou arrêt en fin de range
    pub brightness_min: u8,   // seuil de luminosité minimum (0–127)
    pub brightness_max: u8,   // seuil de luminosité maximum (0–127)
    pub active_note: bool,     // false si le pixel courant est hors seuil (muet)
    pub note_threshold: u8,    // écart minimum de note pour déclencher un changement (0 = toujours)
    pub last_played_note: Option<u8>, // dernière note effectivement jouée
    pub note_is_on: bool,      // true si une note MIDI est actuellement en train de sonner (sustain)
    pub velocity: u8,          // vélocité MIDI courante, dérivée de la luminosité du pixel (1–127)
}

impl Synth {
    pub fn new(id: u32) -> Self {
        Self {
            id,
            playing: false,
            cursor: 0,
            note: 69, // LA4
            channel: 0,
            pixel_start: 0,
            pixel_end: 0,         // 0 signifie "fin de l'image"
            loop_enabled: true,   // boucle activée par défaut
            brightness_min: 0,
            brightness_max: 127,
            active_note: true,
            note_threshold: 0,
            last_played_note: None,
            note_is_on: false,
            velocity: 100,
        }
    }
}

/// Registre de tous les synthés créés par l'utilisateur.
pub struct SynthState {
    pub synths: Mutex<HashMap<u32, Synth>>,
    pub next_id: Mutex<u32>,
}

impl Default for SynthState {
    fn default() -> Self {
        Self {
            synths: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}

/// Connexion MIDI unique, partagée par tous les synthés pour l'instant.
/// Chaque synthé pourra plus tard choisir son propre port.
pub struct MidiState {
    pub connection: Mutex<Option<MidiOutputConnection>>,
}

impl Default for MidiState {
    fn default() -> Self {
        Self {
            connection: Mutex::new(None),
        }
    }
}