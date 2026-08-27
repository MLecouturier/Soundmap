# SoundMap

SoundMap is a Tauri desktop application that turns an image into sound material. It lets you load an image, preview a processed version of it, and prepare a music generation process based on its pixels.

## Main Features

### Image Processing

- Loading an image via a native file dialog.
- Preview of the original image and the processed image.
- Resizing into a pixel grid using nearest-neighbor interpolation.
- Adjusting the number of columns with a single slider.
- Automatic preservation of the width/height ratio when the corresponding option is enabled.
- Separate adjustment of the grid height when ratio preservation is disabled.
- Grayscale, contrast, and brightness adjustments.
- Posterization, i.e. reduction of the number of color or brightness levels.
- Resetting processing parameters.

### MIDI Generation and Export

- Reading pixel data from the processed image to drive sound generation.
- Configurable mapping of columns and pixel values to notes, pitches, or synthesis parameters.
- Preparation of a MIDI export to use the result in a compatible sequencer or instrument.
- MIDI export may rely on Rust crates such as `midly` for file writing and `midir` for real-time MIDI communication, depending on the features enabled in the version used.

## Tech Stack

- **Tauri 2** for the desktop application and communication between the frontend and backend.
- **Rust 2021** for image processing, application state, and audio/MIDI generation and export.
- **Vanilla HTML, CSS, and JavaScript** for the user interface, without any frontend framework or bundler.
- Relevant Rust crates:
  - [`tauri`](https://crates.io/crates/tauri) and [`tauri-plugin-dialog`](https://crates.io/crates/tauri-plugin-dialog) for the application and native dialogs;
  - [`image`](https://crates.io/crates/image) for loading and processing images;
  - [`serde`](https://crates.io/crates/serde) and [`serde_json`](https://crates.io/crates/serde_json) for data exchange;
  - [`base64`](https://crates.io/crates/base64) for sending PNG previews to the frontend;
  - [`midly`](https://crates.io/crates/midly) and [`midir`](https://crates.io/crates/midir) for planned or added MIDI features.

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
cd SoundMap
```

Then make sure the frontend files referenced by `src-tauri/tauri.conf.json` are present in the configured frontend directory.

## Usage

Run SoundMap in development mode:

```bash
cargo tauri dev
```

Build a distributable version:

```bash
cargo tauri build
```

In the application, load an image, adjust the grid using the column slider, enable ratio preservation if needed, then tweak the grayscale, contrast, brightness, and posterization settings. The preview is recalculated whenever settings change.

## Project Structure

A simple layout could look like this:

```text
SoundMap/
├── Cargo.toml
├── LICENSE
├── README.md
├── src/
│   ├── index.html
│   ├── css/
│   │   └── styles.css
│   └── js/
│       └── main.js
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    └── src/
        ├── main.rs
        ├── image_processing.rs
        └── state.rs
```

Exact paths may vary depending on the chosen Tauri configuration. The backend exposes Tauri commands to load the image, apply adjustments, and retrieve pixel data.

## License

This project is licensed under the GNU GPL v3. You are free to use, modify, and redistribute this code, provided that any derivative work is also published under GPLv3 with its sources. See the [LICENSE](LICENSE) file for the full text.
