# SoundMap

*[Version française](README.fr.md)*

SoundMap is a Tauri desktop application that turns an image into music. Load an image, turn it into a pixel grid, and let one or more synthesizers read that grid to generate real-time MIDI notes — turning colors and brightness into sound.

## Main Features

### Image Processing

- Loading an image via a native file dialog.
- Preview of the original image and the processed image, with a toggle to switch between the two.
- Resizing into a pixel grid, where each cell becomes one step in the sequence.
- Adjusting the number of columns with a logarithmic-scale slider (the height is deduced automatically to preserve the aspect ratio).
- Grayscale, contrast, brightness, and posterization (color/brightness level reduction) adjustments.
- Resetting all processing parameters to their default values.
- Image controls are automatically locked while any synthesizer is playing, to keep the pixel grid stable during playback ("Show original" stays available).

### Synthesizers

You can create any number of independent synthesizers, each reading the pixel grid on its own and sending MIDI notes in real time, driven by a shared metronome (tempo in BPM).

- **Two pixel-to-note translation modes, switchable per synthesizer:**
  - **Monophonic** — the pixel's hue (HSL color wheel) determines a single note. A hue shift slider (0–360°) lets you rotate the color wheel to change the dominant tonality of the piece.
  - **Polyphonic** — each color channel (Red, Green, Blue) is read independently and mapped to its own note, forming a 1-to-3-note chord. Each channel can be enabled or disabled individually. Hovering over the R/G/B toggle buttons displays that channel's intensity map directly over the image, to help you decide which channels to use.
- **Pixel range** — define, via a dual-handle slider or by clicking two points directly on the image, the start and end pixels a synthesizer should read.
- **Loop or one-shot playback** — a synthesizer can either loop over its pixel range indefinitely or stop automatically once it reaches the end.
- **Brightness threshold** — a dual-handle slider defines the brightness range a pixel must fall into to be audible; pixels outside that range are silently skipped.
- **Note change threshold** — a minimum hue/color variation (0 to 12/24 semitones) required between two consecutive pixels before a new note is triggered; otherwise, the current note simply keeps sustaining (legato) instead of being retriggered.
- **Minimum velocity** — sets the floor of the velocity range; pixel brightness is mapped between this floor and the maximum velocity (127). Darker pixels are played louder, brighter pixels more delicately.
- **MIDI channel selection** per synthesizer (16 channels available), locked while the synthesizer is playing.
- **Color tagging** — each synthesizer is assigned a color (with a picker of predefined swatches), used to highlight its pixel range and current playback position directly on the image.
- **Visibility toggle** for the pixel-range highlight, automatically hidden during playback to only show the current playback cursor.
- Per-synthesizer play/stop, plus a "play all / stop all" button for the whole synthesizer list.
- The shared metronome starts automatically as soon as any synthesizer starts playing, and stops automatically once all synthesizers are idle.

### MIDI Output

- Automatic connection to the first available MIDI output port on startup.
- Real-time Note On / Note Off messages, with proper legato/sustain handling (notes are only retriggered when they actually change) and clean note-off when stopping a synthesizer or switching modes.

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

1. Load an image and adjust the grid size, grayscale, contrast, brightness, and posterization settings. The preview updates live.
2. Add one or more synthesizers, choose a MIDI channel and a color for each.
3. Configure each synthesizer's pixel range, translation mode (monophonic/polyphonic), brightness threshold, note change threshold, and minimum velocity.
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
        ├── image_processing.rs
        ├── synth.rs
        ├── metronome.rs
        └── midi.rs
```

The backend exposes Tauri commands to load images, apply adjustments, retrieve pixel data, manage synthesizers (creation, playback, MIDI channel, mode, ranges, thresholds, velocity), and drive the shared metronome.

## License

This project is licensed under the GNU GPL v3. You are free to use, modify, and redistribute this code, provided that any derivative work is also published under GPLv3 with its sources. See the [LICENSE](LICENSE) file for the full text.
