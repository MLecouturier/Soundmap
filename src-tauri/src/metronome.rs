use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use image::{DynamicImage, GenericImageView};

use crate::error::{err, AppError};
use crate::state::{ImageState, NoteLength, PixelZone, Synth, SynthMode, SynthState, MidiState};

/// Computes the perceived brightness of an RGBA pixel (Rec.601 formula), 0.0–255.0.
fn pixel_luma(r: u8, g: u8, b: u8) -> f32 {
    0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32
}

/// Computes the hue of an RGB pixel using the HSL color model, in degrees (0.0–360.0).
/// For an achromatic pixel (pure gray, r=g=b), the hue is undefined; we return 0.0.
fn pixel_hue(r: u8, g: u8, b: u8) -> f32 {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;

    if delta.abs() < f32::EPSILON {
        return 0.0; // gray: hue undefined
    }

    let hue = if max == r {
        60.0 * (((g - b) / delta) % 6.0)
    } else if max == g {
        60.0 * (((b - r) / delta) + 2.0)
    } else {
        60.0 * (((r - g) / delta) + 4.0)
    };

    if hue < 0.0 { hue + 360.0 } else { hue }
}

/// Maps a hue (0–360°) to a MIDI note 0–127.
fn hue_to_midi_note(hue: f32) -> u8 {
    ((hue / 360.0) * 127.0).round().clamp(0.0, 127.0) as u8
}

/// Maps a color channel value (0–255) to a MIDI note 0–127.
fn channel_to_midi_note(value: u8) -> u8 {
    ((value as f32 / 255.0) * 127.0).round() as u8
}

/// Maps a brightness value (0–255) to a MIDI level 0–127 (used for
/// brightness-threshold filtering, independently of the note played).
fn luma_to_level(luma: f32) -> u8 {
    ((luma / 255.0) * 127.0).round() as u8
}

/// Computes the HSL saturation of an RGB pixel, in 0.0–255.0.
fn pixel_saturation(r: u8, g: u8, b: u8) -> f32 {
    let (r, g, b) = (r as f32, g as f32, b as f32);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;

    if max <= f32::EPSILON {
        0.0 // black: saturation undefined
    } else {
        delta / max * 255.0
    }
}

/// Maps a saturation value (0–255) to a MIDI velocity between
/// `velocity_min` and 127 (the more saturated the pixel, the stronger
/// the velocity: achromatic areas are played delicately, vivid colors
/// with more intensity). `velocity_min` therefore defines the floor of
/// the velocity range, not a silence threshold.
fn saturation_to_velocity(saturation: f32, velocity_min: u8) -> u8 {
    let min = velocity_min.min(126) as f32;
    let range = 127.0 - min;
    let v = (min + (saturation / 255.0) * range).round() as u8;
    v.clamp(1, 127) // 0 would be equivalent to a Note Off in MIDI
}

/// Processes a pixel in monophonic mode: the hue (shifted by hue_shift)
/// determines a single note. `retrigger` forces a note re-articulation on
/// every pixel (used when note lengths are enabled, where each pixel is a
/// distinct note of a fixed duration, disabling the legato sustain).
fn process_monophonic(
    synth: &mut Synth,
    midi: &MidiState,
    r: u8, g: u8, b: u8,
    brightness_level: u8,
    velocity: u8,
    payload: &mut serde_json::Value,
    retrigger: bool,
) {
    let hue = pixel_hue(r, g, b);
    let shifted_hue = (hue + synth.hue_shift as f32) % 360.0;
    let raw_note = hue_to_midi_note(shifted_hue);
    // Fold the hue-derived note into the enabled MIDI range filters
    let range_note = fold_note_into_range(raw_note, &synth.mono_note_range);

    // Apply the note change threshold: if the gap with the last retained
    // note is insufficient, keep that last note (the current note is
    // therefore sustained, not retriggered).
    let effective_note = if synth.note_threshold == 0 {
        range_note
    } else {
        match synth.last_played_note {
            None => range_note,
            Some(last) => {
                let diff = (range_note as i16 - last as i16).unsigned_abs() as u8;
                if diff >= synth.note_threshold { range_note } else { last }
            }
        }
    };

    let in_range = brightness_level >= synth.brightness_min
        && brightness_level <= synth.brightness_max;

    // We only (re)trigger MIDI if the note actually changes or if its
    // audible status (muted / not muted) changes. Otherwise we let the
    // current note keep sounding without interruption (legato).
    let note_changed = effective_note != synth.note || retrigger;
    let needs_off = synth.note_is_on && (note_changed || !in_range);
    let needs_on  = in_range && (!synth.note_is_on || note_changed);

    if needs_off {
        midi.note_off(synth.midi_port, synth.channel, synth.note);
        synth.note_is_on = false;
    }

    synth.note = effective_note;
    synth.active_note = in_range;
    if in_range {
        synth.last_played_note = Some(effective_note);
    }

    if needs_on {
        midi.note_on(synth.midi_port, synth.channel, effective_note, velocity);
        synth.note_is_on = true;
        synth.note_generation = synth.note_generation.wrapping_add(1);
    }

    payload["note"] = serde_json::json!(effective_note);
    payload["raw_note"] = serde_json::json!(raw_note);
    payload["hue"] = serde_json::json!(hue);
    payload["muted"] = serde_json::json!(!in_range);
}

/// Processes a pixel in polyphonic mode: each enabled R/G/B channel generates
/// its own independent note, forming a chord of 1 to 3 notes. `retrigger`
/// forces a re-articulation of every enabled voice on each pixel (used when
/// note lengths are enabled, see process_monophonic).
fn process_polyphonic(
    synth: &mut Synth,
    midi: &MidiState,
    r: u8, g: u8, b: u8,
    brightness_level: u8,
    velocity: u8,
    payload: &mut serde_json::Value,
    retrigger: bool,
) {
    let channel_values = [r, g, b];
    let channel_midi = synth.channel;
    let global_in_range = brightness_level >= synth.brightness_min
        && brightness_level <= synth.brightness_max;
    let note_threshold = synth.note_threshold;

    let mut voices_payload = Vec::with_capacity(3);

    for i in 0..3 {
        let enabled = synth.channel_enabled[i];
        let raw_note = channel_to_midi_note(channel_values[i]);
        // Fold the channel-derived note into this voice's enabled range filters
        let range_note = fold_note_into_range(raw_note, &synth.voice_note_ranges[i]);
        let voice = &mut synth.poly_voices[i];

        let effective_note = if note_threshold == 0 {
            range_note
        } else {
            match voice.last_played_note {
                None => range_note,
                Some(last) => {
                    let diff = (range_note as i16 - last as i16).unsigned_abs() as u8;
                    if diff >= note_threshold { range_note } else { last }
                }
            }
        };

        let in_range = enabled && global_in_range;

        let note_changed = effective_note != voice.note || retrigger;
        let needs_off = voice.note_is_on && (note_changed || !in_range);
        let needs_on  = in_range && (!voice.note_is_on || note_changed);

        if needs_off {
            midi.note_off(synth.midi_port, channel_midi, voice.note);
            voice.note_is_on = false;
        }

        voice.note = effective_note;
        if in_range {
            voice.last_played_note = Some(effective_note);
        }

        if needs_on {
            midi.note_on(synth.midi_port, channel_midi, effective_note, velocity);
            voice.note_is_on = true;
            synth.note_generation = synth.note_generation.wrapping_add(1);
        }

        voices_payload.push(serde_json::json!({
            "enabled": enabled,
            "note": effective_note,
            "raw_note": raw_note,
            "muted": !in_range,
        }));
    }

    // global active_note: true if at least one voice is sounding (useful for the highlight/UI)
    synth.active_note = synth.poly_voices.iter().enumerate().any(|(i, v)| v.note_is_on && synth.channel_enabled[i]);

    payload["voices"] = serde_json::json!(voices_payload);
    payload["muted"] = serde_json::json!(!global_in_range);
}

/// Builds the flat, ordered list of pixel indices covered by the synth's
/// zones, row by row, zone by zone (in the order they were added). An empty
/// zone list covers the whole image; zones are clipped to the image bounds.
fn build_pixel_sequence(zones: &[PixelZone], width: usize, height: usize) -> Vec<usize> {
    let total = width * height;
    if zones.is_empty() {
        return (0..total).collect();
    }

    let mut sequence = Vec::new();
    for zone in zones {
        let x0 = (zone.x as usize).min(width);
        let y0 = (zone.y as usize).min(height);
        let x1 = (x0 + zone.w as usize).min(width);
        let y1 = (y0 + zone.h as usize).min(height);
        for y in y0..y1 {
            for x in x0..x1 {
                sequence.push(y * width + x);
            }
        }
    }
    sequence
}

/// Plays the pixel at the synth's current playhead position, then advances
/// the playhead by one pixel in its zone sequence (MIDI notes + UI payload),
/// exactly like a metronome tick would. Used both by the metronome thread
/// and by the manual step command; the synth does not need to be playing.
///
/// Returns `Some(length_beats)` when note lengths are enabled: the pixel
/// occupies exactly that duration (in beats of the synth's own tempo),
/// which the caller applies to the tempo accumulator. `None` means the
/// historical behavior: quarter-note steps with legato sustain.
fn step_synth_once(
    app: &AppHandle,
    synth: &mut Synth,
    image: &DynamicImage,
    midi: &MidiState,
) -> Option<f64> {
    let width = image.width() as usize;
    let height = image.height() as usize;

    // Flat sequence of pixels covered by the synth's zones (empty zone list
    // = the whole image). The cursor is an index into this sequence; zones
    // partially outside the image are clipped, and a zone list that covers
    // nothing leaves the synth stalled.
    let sequence = build_pixel_sequence(&synth.zones, width, height);
    let seq_len = sequence.len();
    if seq_len == 0 {
        return None;
    }

    // Deferred end of a non-looping sequence: end_pending means the last
    // pixel was played on the previous tick and its note has now rung for
    // a full step period — stop the synth.
    if synth.end_pending && !synth.loop_enabled && synth.playing {
        synth.playing = false;
        synth.cursor = 0;
        synth.last_played_note = None;
        synth.tempo_accumulator = 0.0;
        // Turn off the current mono note if it is still sounding
        if synth.note_is_on {
            midi.note_off(synth.midi_port, synth.channel, synth.note);
            synth.note_is_on = false;
        }
        // Turn off any currently sounding polyphonic voices
        for voice in synth.poly_voices.iter_mut() {
            if voice.note_is_on {
                midi.note_off(synth.midi_port, synth.channel, voice.note);
                voice.note_is_on = false;
            }
            voice.last_played_note = None;
        }
        let _ = app.emit("synth-stopped", serde_json::json!({ "id": synth.id }));
        return None;
    }

    let pos = synth.cursor % seq_len;

    // Read the pixel at the current playhead position (the payload reports
    // the absolute pixel index, not the sequence index)
    let pixel_index = sequence[pos];
    let px = pixel_index as u32;
    let x = px % width as u32;
    let y = px / width as u32;
    let pixel = image.get_pixel(x, y);
    let (r, g, b, a) = (pixel[0], pixel[1], pixel[2], pixel[3]);
    let luma = pixel_luma(r, g, b);
    let brightness_level = luma_to_level(luma);
    let saturation = pixel_saturation(r, g, b);
    let velocity = saturation_to_velocity(saturation, synth.velocity_min);
    synth.velocity = velocity;

    // Note lengths: when enabled, the pixel's brightness picks a duration
    // among the enabled lengths and each pixel is played as a distinct
    // note of that fixed duration (no legato). Empty list = all quarter
    // notes, i.e. the historical legato behavior. The duration applies
    // even to muted pixels, so the rhythm structure stays consistent.
    let note_length = if synth.note_lengths.is_empty() {
        None
    } else {
        Some(pick_note_length(synth, brightness_level))
    };
    let retrigger = note_length.is_some();

    let mut payload = serde_json::json!({
        "id": synth.id,
        "cursor": pixel_index,
        "r": r, "g": g, "b": b, "a": a,
        "brightness_level": brightness_level,
        "velocity": velocity,
        "mode": synth.mode,
    });

    match synth.mode {
        SynthMode::Monophonic => {
            process_monophonic(
                synth, midi, r, g, b,
                brightness_level, velocity, &mut payload, retrigger,
            );
        }
        SynthMode::Polyphonic => {
            process_polyphonic(
                synth, midi, r, g, b,
                brightness_level, velocity, &mut payload, retrigger,
            );
        }
    }

    let _ = app.emit("synth-pixel-tick", payload);

    // Then advance the playhead for the next step. At the end of a
    // non-looping sequence, wrap the playhead but raise end_pending: the
    // next tick stops the synth, giving the final note a full step
    // duration. A paused synth simply wraps around and clears the flag.
    let next_pos = pos + 1;
    synth.cursor = next_pos % seq_len;
    synth.end_pending = next_pos >= seq_len && !synth.loop_enabled;

    note_length
}

/// Duration of a note length, in beats of the synth's own tempo.
fn length_beats(length: NoteLength) -> f64 {
    match length {
        NoteLength::Whole => 4.0,
        NoteLength::Half => 2.0,
        NoteLength::Quarter => 1.0,
        NoteLength::Eighth => 0.5,
        NoteLength::Sixteenth => 0.25,
    }
}

/// Maps the pixel's brightness level (0–127) to a duration among the
/// enabled note lengths: the level range is split into as many equal
/// bands as enabled lengths. By default the darkest band gets the
/// shortest length and the brightest the longest; `note_length_reversed`
/// flips the direction.
fn pick_note_length(synth: &Synth, brightness_level: u8) -> f64 {
    let mut lengths: Vec<f64> = synth
        .note_lengths
        .iter()
        .map(|&l| length_beats(l))
        .collect();
    if synth.note_length_reversed {
        lengths.sort_by(|a, b| b.partial_cmp(a).unwrap());
    } else {
        lengths.sort_by(|a, b| a.partial_cmp(b).unwrap());
    }
    let n = lengths.len();
    let idx = (brightness_level as usize * n / 128).min(n - 1);
    lengths[idx]
}

/// Bounds of the three note-range filters (bass, medium, treble), in MIDI
/// note numbers. Toggles are cumulative: the allowed range is the union of
/// the enabled sub-ranges.
const NOTE_RANGE_BOUNDS: [(u8, u8); 3] = [(21, 47), (48, 71), (72, 108)];

/// Collects the (low, high) bounds of the enabled sub-ranges.
fn active_note_ranges(toggles: &[bool; 3]) -> Vec<(u8, u8)> {
    NOTE_RANGE_BOUNDS
        .iter()
        .zip(toggles.iter())
        .filter(|(_, &on)| on)
        .map(|(&(lo, hi), _)| (lo, hi))
        .collect()
}

/// Folds a note into the allowed sub-ranges by octaves (a note outside the
/// allowed range is transposed up or down by whole octaves until it lands
/// in one of them, preserving its pitch class). With no sub-range enabled
/// the full MIDI range (0–127) is allowed and the note is unchanged.
fn fold_note_into_range(note: u8, toggles: &[bool; 3]) -> u8 {
    let allowed = active_note_ranges(toggles);
    if allowed.is_empty() {
        return note;
    }
    if allowed.iter().any(|&(lo, hi)| note >= lo && note <= hi) {
        return note;
    }

    // Each active sub-range spans more than one octave (27, 24 and 37
    // semitones), so a valid fold always exists; try both directions by
    // increasing octave distance, folding down first.
    for octave in 1..=10i32 {
        for &sign in &[-1i32, 1] {
            let candidate = note as i32 + sign * 12 * octave;
            if (0..=127).contains(&candidate)
                && allowed
                    .iter()
                    .any(|&(lo, hi)| candidate >= lo as i32 && candidate <= hi as i32)
            {
                return candidate as u8;
            }
        }
    }
    note
}

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
            return; // already running
    }
    state.running.store(true, Ordering::Relaxed);

    let running = state.running.clone();
    let bpm = state.bpm.clone();

    thread::spawn(move || {
        let mut beat_index: u64 = 0;
        let mut sub_beat: u32 = 0; // 0..3: each beat is split into 4 wakes,
                                   // to give eighth/sixteenth note lengths
                                   // enough time resolution
        while running.load(Ordering::Relaxed) {
            let current_bpm = bpm.load(Ordering::Relaxed).max(1);
            let beat_ms = 60_000u64 / current_bpm as u64;

            if sub_beat == 0 {
                let _ = app.emit("metronome-tick", beat_index);
            }

            // --- Advancing active synths over the image ---
            let image_state = app.state::<ImageState>();
            let synth_state = app.state::<SynthState>();
            let midi_state = app.state::<MidiState>();

            if let Some(image) = image_state.processed.lock().unwrap().as_ref() {
                let mut synths = synth_state.synths.lock().unwrap();

                for synth in synths.values_mut() {
                    if !synth.playing {
                        continue;
                    }

                    // Tempo desynchronization: each quarter-beat wake adds a
                    // quarter of the synth's tempo ratio to its accumulator;
                    // the synth advances when at least one full step has
                    // accumulated (e.g. ratio 0.5 = one pixel every two beats).
                    synth.tempo_accumulator += synth.tempo_ratio * 0.25;
                    if synth.tempo_accumulator < 1.0 {
                        continue;
                    }
                    synth.tempo_accumulator -= 1.0;

                    let played_length = step_synth_once(&app, synth, image, &midi_state);
                    if let Some(length_beats) = played_length {
                        // Note lengths enabled: the played pixel occupies
                        // exactly its note's duration. Rewind the accumulator
                        // so the next pixel is due after `length_beats` beats
                        // of the synth's own tempo (i.e. length_beats / ratio
                        // metronome beats).
                        synth.tempo_accumulator = 1.0 - length_beats;
                    }
                }
            }

            sub_beat = (sub_beat + 1) % 4;
            if sub_beat == 0 {
                beat_index += 1;
            }
            thread::sleep(Duration::from_millis(beat_ms / 4));
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

/// Manually advances a synth's playhead by one pixel in its zone sequence,
/// playing the resulting pixel like a metronome tick would. Only usable
/// while the synth is paused. The notes played by a manual step have a
/// fixed duration — the pixel's note length when note lengths are enabled,
/// otherwise the synth's own step period (metronome interval divided by
/// its tempo ratio) — after which a Note Off is sent.
#[tauri::command]
pub fn step_synth(
    app: AppHandle,
    id: u32,
    image_state: State<'_, ImageState>,
    synth_state: State<SynthState>,
    midi_state: State<MidiState>,
    metronome_state: State<'_, MetronomeState>,
) -> Result<(), AppError> {
    let bpm = metronome_state.bpm.load(Ordering::Relaxed).max(1) as u64;
    let interval_ms = 60_000u64 / bpm;

    let (port, channel, scheduled, generation, step_duration) = {
        let image_guard = image_state.processed.lock().unwrap();
        let image = match image_guard.as_ref() {
            Some(img) => img,
            None => return Err(err("no_processed_image")),
        };

        let mut synths = synth_state.synths.lock().unwrap();
        let synth = match synths.get_mut(&id) {
            Some(s) => s,
            None => return Err(err("synth_not_found").with_param("id", id)),
        };

        if synth.playing {
            return Err(err("synth_is_playing").with_param("id", id));
        }

        let played_length = step_synth_once(&app, synth, image, &midi_state);

        // Duration of the notes just played: the pixel's note length when
        // note lengths are enabled, otherwise the synth's regular step
        // period. Both are scaled by the tempo ratio (e.g. ratio 0.5 =
        // twice the metronome period).
        let ratio = if synth.tempo_ratio > 0.0 { synth.tempo_ratio } else { 1.0 };
        let beats = played_length.unwrap_or(1.0);
        let step_duration = ((interval_ms as f64) * beats / ratio).round().max(1.0) as u64;

        // Capture the notes that are now sounding, to schedule their Note Off
        let mut scheduled = Vec::new();
        if synth.note_is_on {
            scheduled.push(synth.note);
        }
        for voice in &synth.poly_voices {
            if voice.note_is_on {
                scheduled.push(voice.note);
            }
        }
        (synth.midi_port, synth.channel, scheduled, synth.note_generation, step_duration)
    };

    if scheduled.is_empty() {
        return Ok(());
    }

    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(step_duration));

        // Turn the captured notes off only if the synth is still paused and
        // still sounding those same articulation: a newer manual step (a
        // different note generation), a stop, or the metronome taking over
        // in the meantime cancels the cutoff.
        let synth_state = app.state::<SynthState>();
        let midi_state = app.state::<MidiState>();

        let mut synths = synth_state.synths.lock().unwrap();
        let synth = match synths.get_mut(&id) {
            Some(s) => s,
            None => return,
        };
        if synth.playing || synth.channel != channel || synth.note_generation != generation {
            return;
        }

        // The notes were sent on the captured port: even if the synth has
        // since changed ports, turn them off where they are sounding.
        if synth.note_is_on && scheduled.contains(&synth.note) {
            midi_state.note_off(port, channel, synth.note);
            synth.note_is_on = false;
        }
        for voice in synth.poly_voices.iter_mut() {
            if voice.note_is_on && scheduled.contains(&voice.note) {
                midi_state.note_off(port, channel, voice.note);
                voice.note_is_on = false;
            }
        }
    });

    Ok(())
}