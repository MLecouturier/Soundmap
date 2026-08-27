use image::DynamicImage;
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
    pub cursor: usize, // index du pixel courant (0..width*height)
}

impl Synth {
    pub fn new(id: u32) -> Self {
        Self { id, playing: false, cursor: 0 }
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