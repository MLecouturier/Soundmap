use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use image::GenericImageView;

use crate::midi::{send_note_off, send_note_on};
use crate::state::{ImageState, Synth, SynthMode, SynthState, MidiState};

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

/// Maps a brightness value (0–255) to a MIDI velocity between
/// `velocity_min` and 127 (the darker the pixel, the stronger the
/// velocity: bright areas are played delicately, dark areas with more
/// intensity). `velocity_min` therefore defines the floor of the
/// velocity range, not a silence threshold.
fn luma_to_velocity(luma: f32, velocity_min: u8) -> u8 {
    let min = velocity_min.min(126) as f32;
    let range = 127.0 - min;
    let v = (min + ((255.0 - luma) / 255.0) * range).round() as u8;
    v.clamp(1, 127) // 0 would be equivalent to a Note Off in MIDI
}

/// Processes a pixel in monophonic mode: the hue (shifted by hue_shift)
/// determines a single note.
fn process_monophonic(
    synth: &mut Synth,
    conn: Option<&mut midir::MidiOutputConnection>,
    r: u8, g: u8, b: u8,
    brightness_level: u8,
    velocity: u8,
    payload: &mut serde_json::Value,
) {
    let hue = pixel_hue(r, g, b);
    let shifted_hue = (hue + synth.hue_shift as f32) % 360.0;
    let raw_note = hue_to_midi_note(shifted_hue);

    // Apply the note change threshold: if the gap with the last retained
    // note is insufficient, keep that last note (the current note is
    // therefore sustained, not retriggered).
    let effective_note = if synth.note_threshold == 0 {
        raw_note
    } else {
        match synth.last_played_note {
            None => raw_note,
            Some(last) => {
                let diff = (raw_note as i16 - last as i16).unsigned_abs() as u8;
                if diff >= synth.note_threshold { raw_note } else { last }
            }
        }
    };

    let in_range = brightness_level >= synth.brightness_min
        && brightness_level <= synth.brightness_max;

    // We only (re)trigger MIDI if the note actually changes or if its
    // audible status (muted / not muted) changes. Otherwise we let the
    // current note keep sounding without interruption (legato).
    let note_changed = effective_note != synth.note;
    let needs_off = synth.note_is_on && (note_changed || !in_range);
    let needs_on  = in_range && (!synth.note_is_on || note_changed);

    let mut conn = conn;
    if needs_off {
        if let Some(c) = conn.as_mut() {
            send_note_off(c, synth.channel, synth.note);
        }
        synth.note_is_on = false;
    }

    synth.note = effective_note;
    synth.active_note = in_range;
    if in_range {
        synth.last_played_note = Some(effective_note);
    }

    if needs_on {
        if let Some(c) = conn.as_mut() {
            send_note_on(c, synth.channel, effective_note, velocity);
        }
        synth.note_is_on = true;
    }

    payload["note"] = serde_json::json!(effective_note);
    payload["raw_note"] = serde_json::json!(raw_note);
    payload["hue"] = serde_json::json!(hue);
    payload["muted"] = serde_json::json!(!in_range);
}

/// Processes a pixel in polyphonic mode: each enabled R/G/B channel generates
/// its own independent note, forming a chord of 1 to 3 notes.
fn process_polyphonic(
    synth: &mut Synth,
    conn: Option<&mut midir::MidiOutputConnection>,
    r: u8, g: u8, b: u8,
    brightness_level: u8,
    velocity: u8,
    payload: &mut serde_json::Value,
) {
    let channel_values = [r, g, b];
    let channel_midi = synth.channel;
    let global_in_range = brightness_level >= synth.brightness_min
        && brightness_level <= synth.brightness_max;
    let note_threshold = synth.note_threshold;

    let mut conn = conn;
    let mut voices_payload = Vec::with_capacity(3);

    for i in 0..3 {
        let enabled = synth.channel_enabled[i];
        let raw_note = channel_to_midi_note(channel_values[i]);
        let voice = &mut synth.poly_voices[i];

        let effective_note = if note_threshold == 0 {
            raw_note
        } else {
            match voice.last_played_note {
                None => raw_note,
                Some(last) => {
                    let diff = (raw_note as i16 - last as i16).unsigned_abs() as u8;
                    if diff >= note_threshold { raw_note } else { last }
                }
            }
        };

        let in_range = enabled && global_in_range;

        let note_changed = effective_note != voice.note;
        let needs_off = voice.note_is_on && (note_changed || !in_range);
        let needs_on  = in_range && (!voice.note_is_on || note_changed);

        if needs_off {
            if let Some(c) = conn.as_mut() {
                send_note_off(c, channel_midi, voice.note);
            }
            voice.note_is_on = false;
        }

        voice.note = effective_note;
        if in_range {
            voice.last_played_note = Some(effective_note);
        }

        if needs_on {
            if let Some(c) = conn.as_mut() {
                send_note_on(c, channel_midi, effective_note, velocity);
            }
            voice.note_is_on = true;
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
        while running.load(Ordering::Relaxed) {
            let current_bpm = bpm.load(Ordering::Relaxed).max(1);
            let interval_ms = 60_000u64 / current_bpm as u64;

            let _ = app.emit("metronome-tick", beat_index);

            // --- Advancing active synths over the image ---
            let image_state = app.state::<ImageState>();
            let synth_state = app.state::<SynthState>();
            let midi_state = app.state::<MidiState>();

            if let Some(image) = image_state.processed.lock().unwrap().as_ref() {
                let (width, height) = (image.width() as usize, image.height() as usize);
                let total_pixels = width * height;

                let mut synths = synth_state.synths.lock().unwrap();
                let mut conn_guard = midi_state.connection.lock().unwrap();

                for synth in synths.values_mut() {
                    if synth.playing && total_pixels > 0 {
                        // Determine the effective bounds of the range
                        let range_start = synth.pixel_start.min(total_pixels - 1);
                        let range_end = if synth.pixel_end == 0 || synth.pixel_end >= total_pixels {
                            total_pixels - 1
                        } else {
                            synth.pixel_end
                        };
                        let range_len = if range_end >= range_start {
                            range_end - range_start + 1
                        } else {
                            1
                        };

                        // Advance the cursor within the range
                        let pos_in_range = if synth.cursor >= range_start && synth.cursor <= range_end {
                            synth.cursor - range_start
                        } else {
                            0
                        };
                        let next_pos = pos_in_range + 1;

                        if next_pos >= range_len && !synth.loop_enabled {
                            // End of sequence without looping: stop the synth
                            synth.playing = false;
                            synth.cursor = range_start;
                            synth.last_played_note = None;
                            // Turn off the current mono note if it is still sounding
                            if synth.note_is_on {
                                if let Some(conn) = conn_guard.as_mut() {
                                    send_note_off(conn, synth.channel, synth.note);
                                }
                                synth.note_is_on = false;
                            }
                            // Turn off any currently sounding polyphonic voices
                            for voice in synth.poly_voices.iter_mut() {
                                if voice.note_is_on {
                                    if let Some(conn) = conn_guard.as_mut() {
                                        send_note_off(conn, synth.channel, voice.note);
                                    }
                                    voice.note_is_on = false;
                                }
                                voice.last_played_note = None;
                            }
                            let _ = app.emit("synth-stopped", serde_json::json!({ "id": synth.id }));
                            continue;
                        }

                        synth.cursor = range_start + next_pos % range_len;

                        // Read the current pixel
                        let px = synth.cursor as u32;
                        let x = px % width as u32;
                        let y = px / width as u32;
                        let pixel = image.get_pixel(x, y);
                        let (r, g, b, a) = (pixel[0], pixel[1], pixel[2], pixel[3]);
                        let luma = pixel_luma(r, g, b);
                        let brightness_level = luma_to_level(luma);
                        let velocity = luma_to_velocity(luma, synth.velocity_min);
                        synth.velocity = velocity;

                        let mut payload = serde_json::json!({
                            "id": synth.id,
                            "cursor": synth.cursor,
                            "r": r, "g": g, "b": b, "a": a,
                            "brightness_level": brightness_level,
                            "velocity": velocity,
                            "mode": synth.mode,
                        });

                        match synth.mode {
                            SynthMode::Monophonic => {
                                process_monophonic(
                                    synth, conn_guard.as_mut(), r, g, b,
                                    brightness_level, velocity, &mut payload,
                                );
                            }
                            SynthMode::Polyphonic => {
                                process_polyphonic(
                                    synth, conn_guard.as_mut(), r, g, b,
                                    brightness_level, velocity, &mut payload,
                                );
                            }
                        }

                        let _ = app.emit("synth-pixel-tick", payload);
                    }
                }
            }

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