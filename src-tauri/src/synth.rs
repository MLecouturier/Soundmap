use serde::{Deserialize, Serialize};

// ... (ColorChannel, ChannelMode, Region, ColorSlot, NoteEvent inchangés) ...

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SynthConfig {
    pub id: String,
    pub midi_channel: u8,
    pub region: Region,
    pub channel_mode: ChannelMode,
    pub min_threshold: u8,
    pub max_threshold: u8,
    pub tolerance: u8,
    pub note_min: u8,
    pub note_max: u8,
    /// Si true, on recommence au premier pixel de la région une fois la fin atteinte.
    /// Si false, la lecture s'arrête (et coupe les notes) au dernier pixel.
    pub loop_playback: bool,
    /// Si false, ce synthé est ignoré lors du tick (pause).
    pub enabled: bool,
}

#[derive(Debug, Clone, Default)]
struct VoiceState {
    active_note: Option<u8>,
    last_value: Option<u8>,
}

pub struct SynthEngine {
    pub config: SynthConfig,
    voices: std::collections::HashMap<ColorSlot, VoiceState>,
    /// Index du pixel courant dans la région (0 = premier pixel du balayage ligne par ligne).
    cursor: u32,
    /// Devient true quand la lecture est terminée (mode non-loop, fin de région atteinte).
    finished: bool,
}

impl SynthEngine {
    pub fn new(config: SynthConfig) -> Self {
        Self {
            config,
            voices: std::collections::HashMap::new(),
            cursor: 0,
            finished: false,
        }
    }

    fn map_to_note(&self, value: u8) -> u8 {
        let range = self.config.note_max.saturating_sub(self.config.note_min) as f32;
        let ratio = value as f32 / 255.0;
        self.config.note_min + (ratio * range).round() as u8
    }

    fn map_to_velocity(&self, value: u8) -> u8 {
        let inverted = 255 - value;
        ((inverted as u16 * 127) / 255).max(1) as u8
    }

    fn slots_for_mode(&self) -> Vec<ColorSlot> {
        match &self.config.channel_mode {
            ChannelMode::Grayscale => vec![ColorSlot::Gray],
            ChannelMode::Rgb(channels) => {
                channels.iter().map(|c| ColorSlot::Channel(*c)).collect()
            }
        }
    }

    fn extract_value(&self, slot: ColorSlot, r: u8, g: u8, b: u8) -> u8 {
        match slot {
            ColorSlot::Gray => {
                (0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32).round() as u8
            }
            ColorSlot::Channel(ColorChannel::Red) => r,
            ColorSlot::Channel(ColorChannel::Green) => g,
            ColorSlot::Channel(ColorChannel::Blue) => b,
        }
    }

    fn process_pixel(&mut self, r: u8, g: u8, b: u8) -> Vec<NoteEvent> {
        let mut events = Vec::new();
        let channel = self.config.midi_channel;
        let slots = self.slots_for_mode();

        for slot in slots {
            let value = self.extract_value(slot, r, g, b);
            let voice = self.voices.entry(slot).or_default();

            let in_range =
                value >= self.config.min_threshold && value <= self.config.max_threshold;

            if !in_range {
                if let Some(note) = voice.active_note.take() {
                    events.push(NoteEvent::Off { channel, note });
                }
                voice.last_value = None;
                continue;
            }

            let should_extend = match (voice.active_note, voice.last_value) {
                (Some(_), Some(last)) => {
                    let diff = if value > last { value - last } else { last - value };
                    diff <= self.config.tolerance
                }
                _ => false,
            };

            if should_extend {
                voice.last_value = Some(value);
                continue;
            }

            if let Some(old_note) = voice.active_note.take() {
                events.push(NoteEvent::Off { channel, note: old_note });
            }

            let note = self.map_to_note(value);
            let velocity = self.map_to_velocity(value);
            events.push(NoteEvent::On { channel, note, velocity });

            voice.active_note = Some(note);
            voice.last_value = Some(value);
        }

        events
    }

    pub fn stop_all(&mut self) -> Vec<NoteEvent> {
        let channel = self.config.midi_channel;
        let mut events = Vec::new();
        for voice in self.voices.values_mut() {
            if let Some(note) = voice.active_note.take() {
                events.push(NoteEvent::Off { channel, note });
            }
        }
        events
    }

    /// Remet le curseur au début de la région (utile après un changement de région/config).
    pub fn reset(&mut self) {
        self.cursor = 0;
        self.finished = false;
    }

    /// Convertit l'index séquentiel du curseur en coordonnées (x, y) dans la région,
    /// selon un balayage ligne par ligne.
    fn cursor_to_xy(&self, cursor: u32) -> (u32, u32) {
        let region = self.config.region;
        let w = region.width.max(1);
        let x = region.x + (cursor % w);
        let y = region.y + (cursor / w);
        (x, y)
    }

    /// Appelée à chaque `metronome-tick`. Lit UN pixel (celui pointé par le curseur),
    /// avance le curseur, et retourne les événements MIDI générés.
    /// Si le synthé est désactivé ou a fini sa lecture (mode non-loop), retourne un Vec vide.
    pub fn tick(&mut self, image_width: u32, pixels: &[u8]) -> Vec<NoteEvent> {
        if !self.config.enabled || self.finished {
            return Vec::new();
        }

        let region = self.config.region;
        let total_pixels = region.width.saturating_mul(region.height);
        if total_pixels == 0 {
            return Vec::new();
        }

        let (x, y) = self.cursor_to_xy(self.cursor);
        let idx = ((y * image_width + x) * 4) as usize;

        let events = if idx + 3 < pixels.len() {
            let r = pixels[idx];
            let g = pixels[idx + 1];
            let b = pixels[idx + 2];
            self.process_pixel(r, g, b)
        } else {
            Vec::new()
        };

        // Avance le curseur pour le prochain tick.
        self.cursor += 1;
        if self.cursor >= total_pixels {
            if self.config.loop_playback {
                self.cursor = 0;
            } else {
                self.finished = true;
            }
        }

        events
    }
}