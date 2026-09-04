# SoundMap

*[Version française](README.fr.md)*

SoundMap is a Tauri desktop application that turns an image into music. Load an image, turn it into a pixel grid, and let one or more synthesizers read that grid to generate real-time MIDI notes — turning colors and brightness into sound.

## Main Features

### Image Processing

- Loading an image via a native file dialog.
- Preview of the original image and the processed image, with a toggle to switch between the two.
- Resizing into a pixel grid, where each cell becomes one step in the sequence.
- Adjusting the number of columns with a logarithmic-scale slider (the height is deduced automatically to preserve the aspect ratio).
- Saturation, contrast, brightness, and posterization (color/brightness level reduction) adjustments.
- Resetting all processing parameters to their default values.
- Image controls are automatically locked while any synthesizer is playing, to keep the pixel grid stable during playback ("Show original" stays available).

### Synthesizers

You can create any number of independent synthesizers, each reading the pixel grid on its own and sending MIDI notes in real time, driven by a shared metronome (tempo in BPM). Each synthesizer can run at its own fraction of the main tempo, so several synths can drift apart and create polyrhythms.

- **Two pixel-to-note translation modes, switchable per synthesizer:**
  - **Monophonic** — the pixel's hue (HSL color wheel) determines a single note. A hue shift slider (0–360°) lets you rotate the color wheel to change the dominant tonality of the piece.
  - **Polyphonic** — each color channel (Red, Green, Blue) is read independently and mapped to its own note, forming a 1-to-3-note chord. Each channel can be enabled or disabled individually. Hovering over the R/G/B toggle buttons displays that channel's intensity map directly over the image, to help you decide which channels to use.
- **Rectangular zones** — select the pixels each synthesizer plays by drawing rectangles directly on the image. All pixels are selected by default; a rectangle dragged from a free pixel adds a zone, while one dragged from an already selected pixel removes those pixels instead. The zone row also displays the total number of selected pixels and the estimated playing time at the synth's own tempo.
- **Per-synth tempo** — each synthesizer can play at a fraction of the main metronome tempo (1/1, 3/4, 2/3, 1/2, 1/3 or 1/4 of the global BPM), letting synths desynchronize from one another for more dynamic music.
- **Note lengths** — checkboxes for sixteenth, eighth, quarter, half and whole notes let the pixel's brightness choose the note's duration among the enabled lengths (the 0–127 brightness range is split into as many equal bands). Each pixel is played for exactly its note's duration, so the image's brightness contrast translates directly into rhythm. A reverse button flips the brightness→length direction (dark = long instead of bright = long); the quarter-note box always stays checked.
- **MIDI note range filters** — bass (21–47), medium (48–71) and treble (72–108) toggles restrict the notes a synthesizer can play. Toggles are cumulative to extend the allowed range; with none active, the full 0–127 range is available. Notes that fall outside the allowed range are folded into it by octaves, preserving their pitch class. Monophonic mode has a single filter; each polyphonic R/G/B voice has its own.
- **Playback controls** — play/stop, rewind (resets the playhead to the beginning of the sequence) and step forward (manually advances by one pixel while paused, playing it with its own note length).
- **Loop or one-shot playback** — a synthesizer can either loop over its zones indefinitely or stop automatically once it reaches the end.
- **Brightness threshold** — a dual-handle slider defines the brightness range a pixel must fall into to be audible; pixels outside that range are silently skipped.
- **Note change threshold** — a minimum variation (in semitones) required between two consecutive pixels before a new note value is retained; below it, the last note is kept, avoiding nervous chromatic jitter.
- **Minimum velocity** — sets the floor of the velocity range; pixel saturation is mapped between this floor and the maximum velocity (127). Vivid colors are played with a stronger attack, achromatic areas more delicately.
- **MIDI channel selection** per synthesizer (16 channels available), locked while the synthesizer is playing.
- **Color tagging** — each synthesizer is assigned a color (with a picker of predefined swatches), used to highlight its zones and its current playback position directly on the image.
- **Visibility toggle** for the zone highlight, automatically hidden during playback to only show the current playback cursor.
- **Collapsible advanced options** — each synthesizer's advanced settings (mode-specific panels, note lengths, note range filters, thresholds, velocity) live in a collapsible section, so the list stays compact when many synthesizers are present.
- Per-synthesizer play/stop, plus a "play all / stop all" button for the whole synthesizer list.
- The shared metronome starts automatically as soon as any synthesizer starts playing, and stops automatically once all synthesizers are idle.

### MIDI Output

- Automatic connection to the first available MIDI output port on startup.
- Real-time Note On / Note Off messages: each pixel is played as a note with its own duration, with clean note-offs when stopping a synthesizer or switching modes. The engine ticks at a quarter-beat resolution so eighth and sixteenth note lengths stay accurate.

## Tech Stack

- **Tauri 2** for the desktop application and communication between the frontend and backend.
- **Rust 2021** for image processing, application state, and real-time MIDI generation.
- **Vanilla HTML, SCSS/CSS, and JavaScript** for the user interface, without any frontend framework or bundler.
- Relevant Rust crates:
  - [`tauri`](https://crates.io/crates/tauri) and [`tauri-plugin-dialog`](https://crates.io/crates/tauri-plugin-dialog) for the application and native dialogs;
  - [`image`](https://crates.io/crates/image) for loading and processing images;
  - [`midir`](https://crates.io/crates/midir) for real-time MIDI output;
  - [`serde`](https://crates.io/crates/serde) and [`serde_json`](https://crates.io/crates/serde_json) for data exchange between the frontend and backend;
  - [`base64`](https://crates.io/crates/base64) for sending PNG previews to the frontend.

## Installation

### Prerequisites

- [Rust](https://www.rust-lang.org/tools/install), with Cargo.
- The system dependencies required by Tauri on your platform.
- The Tauri CLI:

  ```bash
  cargo install tauri-cli
  ```

Node.js is **not required**: the frontend uses vanilla HTML, CSS, and JavaScript, without any frontend bundler or package manager.

### Getting the Project

From the project directory:

```bash
cd soundmap
```

## Usage

Run SoundMap in development mode:

```bash
cargo tauri dev
```

Build a distributable version:

```bash
cargo tauri build
```

In the application:

1. Load an image and adjust the grid size, saturation, contrast, brightness, and posterization settings. The preview updates live.
2. Add one or more synthesizers, choose a MIDI channel and a color for each.
3. Draw zones on the image to restrict what each synthesizer plays, pick a tempo per synth, and open the advanced options to configure the translation mode (monophonic/polyphonic), note lengths, note range filters, brightness threshold, note change threshold, and minimum velocity.
4. Press Play on a synthesizer (or "play all") to start hearing your image.

## Project Structure

```text
soundmap/
├── Cargo.toml
├── LICENSE
├── README.md
├── README.fr.md
├── package.json
├── src/
│   ├── index.html
│   ├── css/
│   │   └── styles.css
│   ├── i18n/
│   ├── scss/
│   │   └── styles.scss
│   └── js/
│       └── main.js
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── main.rs
        ├── lib.rs
        ├── state.rs
        ├── error.rs
        ├── image_processing.rs
        ├── synth.rs
        ├── metronome.rs
        └── midi.rs
```

The backend exposes Tauri commands to load images, apply adjustments, retrieve pixel data, manage synthesizers (creation, playback, MIDI channel, mode, zones, tempo, note lengths, note ranges, thresholds, velocity), and drive the shared metronome.

## License

This project is licensed under the GNU GPL v3. You are free to use, modify, and redistribute this code, provided that any derivative work is also published under GPLv3 with its sources. See the [LICENSE](LICENSE) file for the full text.
