use image::DynamicImage;
use midir::MidiOutputConnection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// Mode used to translate pixels into notes.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SynthMode {
    Monophonic,
    Polyphonic,
}

/// Rectangular zone of the image, in grid cells: (x, y) is the top-left
/// cell, w and h are the extents in cells.
#[derive(Clone, Copy, Serialize, Deserialize, Debug)]
pub struct PixelZone {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Musical note length a pixel can be played as, in the synth's own beats:
/// Whole = 4 beats, Half = 2, Quarter = 1, Eighth = 0.5, Sixteenth = 0.25.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum NoteLength {
    Whole,
    Half,
    Quarter,
    Eighth,
    Sixteenth,
}

/// State of an individual voice in polyphonic mode (one per R/G/B channel).
#[derive(Clone, Copy, Debug)]
pub struct ChannelVoice {
    pub note: u8,
    pub note_is_on: bool,
    pub last_played_note: Option<u8>,
}

impl ChannelVoice {
    pub fn new() -> Self {
        Self {
            note: 0,
            note_is_on: false,
            last_played_note: None,
        }
    }
}

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

/// State of an individual synthesizer.
#[derive(Clone)]
pub struct Synth {
    pub id: u32,
    pub playing: bool,
    pub cursor: usize,      // index into the zone pixel sequence (0..sequence length)
    pub note: u8,           // fixed MIDI note for now: A4 = 69
    pub channel: u8,        // MIDI channel 0-15
    pub zones: Vec<PixelZone>, // rectangular zones to play (empty = whole image)
    pub loop_enabled: bool,   // loop playback or stop at end of range
    pub end_pending: bool,    // end of a non-looping sequence reached: stop on the next tick
                              // (gives the final note a full step duration)
    pub tempo_ratio: f64,      // playback speed relative to the metronome (1.0 = metronome tempo)
    pub tempo_accumulator: f64, // fractional-tick accumulator: a synth with tempo < 1.0
                               // only advances once enough metronome ticks have accumulated
    pub brightness_min: u8,   // minimum brightness threshold (0–127)
    pub brightness_max: u8,   // maximum brightness threshold (0–127)
    pub active_note: bool,     // false if the current pixel is out of range (muted)
    pub note_threshold: u8,    // minimum note gap required to trigger a change (0 = always)
    pub last_played_note: Option<u8>, // last note actually played
    pub note_is_on: bool,      // true if a MIDI note is currently sounding (sustain)
    pub velocity: u8,          // current MIDI velocity, derived from the pixel's brightness (1–127)
    pub velocity_min: u8,      // floor of the velocity range (0–126): brightness is
                               // mapped between this value and 127 (maximum velocity)

    // --- Pixel-to-note translation modes ---
    pub mode: SynthMode,
    pub hue_shift: u16,             // hue shift in degrees (0–360), monophonic mode
    pub channel_enabled: [bool; 3], // R, G, B enabled/disabled, polyphonic mode
    pub poly_voices: [ChannelVoice; 3], // independent MIDI state per R, G, B channel

    // --- Brightness-driven note lengths ---
    pub note_lengths: Vec<NoteLength>, // enabled lengths; empty = all quarter notes
    pub note_length_reversed: bool,    // flip the brightness→length mapping direction
    pub note_generation: u32,          // bumped on each note articulation, so stale
                                       // delayed Note Offs can cancel themselves

    // --- MIDI note range filters ---
    pub mono_note_range: [bool; 3],       // bass, medium, treble enabled for the
                                          // monophonic note (all off = full 0–127)
    pub voice_note_ranges: [[bool; 3]; 3], // same, per R/G/B voice, polyphonic mode
}

impl Synth {
    pub fn new(id: u32) -> Self {
        Self {
            id,
            playing: false,
            cursor: 0,
            note: 69, // A4
            channel: 0,
            zones: Vec::new(),    // empty = whole image
            loop_enabled: true,   // loop enabled by default
            end_pending: false,
            tempo_ratio: 1.0,
            tempo_accumulator: 0.0,
            brightness_min: 0,
            brightness_max: 127,
            active_note: true,
            note_threshold: 0,
            last_played_note: None,
            note_is_on: false,
            velocity: 100,
            velocity_min: 0,

            mode: SynthMode::Monophonic,
            hue_shift: 0,
            channel_enabled: [true, true, true],
            poly_voices: [ChannelVoice::new(), ChannelVoice::new(), ChannelVoice::new()],

            note_lengths: vec![NoteLength::Quarter],
            note_length_reversed: false,
            note_generation: 0,

            mono_note_range: [false, false, false],
            voice_note_ranges: [[false, false, false]; 3],
        }
    }
}

/// Registry of all synthesizers created by the user.
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

/// Single MIDI connection, shared by all synths for now.
/// Each synth may later be able to choose its own port.
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