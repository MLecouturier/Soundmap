# SoundMap

SoundMap est une application de bureau Tauri qui transforme une image en matière sonore. Elle permet de charger une image, d'en prévisualiser une version traitée et de préparer une génération musicale à partir de ses pixels.

## Fonctionnalités principales

### Traitement d'image

- Chargement d'une image depuis un dialogue de fichier natif.
- Aperçu de l'image originale et de l'image traitée.
- Redimensionnement en grille de pixels avec interpolation au plus proche.
- Ajustement du nombre de colonnes à l'aide d'un seul curseur.
- Conservation automatique du ratio largeur/hauteur lorsque l'option correspondante est activée.
- Ajustement séparé de la hauteur de la grille lorsque le maintien du ratio est désactivé.
- Réglages de niveaux de gris, de contraste et de luminosité.
- Posterization, c'est-à-dire réduction du nombre de niveaux de couleur ou de luminosité.
- Réinitialisation des paramètres de traitement.

### Génération et export MIDI

- Lecture des données de pixels de l'image traitée pour alimenter une génération sonore.
- Association configurable des colonnes et des valeurs de pixels à des notes, hauteurs ou paramètres de synthèse.
- Préparation d'un export MIDI pour exploiter le résultat dans un séquenceur ou un instrument compatible.
- L'export MIDI peut s'appuyer sur des crates Rust telles que `midly` pour l'écriture des fichiers et `midir` pour la communication MIDI en temps réel, selon les fonctionnalités activées dans la version utilisée.

## Stack technique

- **Tauri 2** pour l'application de bureau et la communication entre le frontend et le backend.
- **Rust 2021** pour le traitement d'image, l'état applicatif et la génération/export audio ou MIDI.
- **HTML, CSS et JavaScript vanilla** pour l'interface utilisateur, sans framework ni bundler frontend.
- Crates Rust pertinentes :
  - [`tauri`](https://crates.io/crates/tauri) et [`tauri-plugin-dialog`](https://crates.io/crates/tauri-plugin-dialog) pour l'application et les dialogues natifs ;
  - [`image`](https://crates.io/crates/image) pour le chargement et le traitement des images ;
  - [`serde`](https://crates.io/crates/serde) et [`serde_json`](https://crates.io/crates/serde_json) pour les échanges de données ;
  - [`base64`](https://crates.io/crates/base64) pour transmettre les aperçus PNG au frontend ;
  - [`midly`](https://crates.io/crates/midly) et [`midir`](https://crates.io/crates/midir) pour les fonctions MIDI prévues ou ajoutées au projet.

## Installation

### Prérequis

- [Rust](https://www.rust-lang.org/tools/install), avec Cargo.
- Les dépendances système nécessaires à Tauri sur votre plateforme.
- La CLI Tauri :

  ```bash
  cargo install tauri-cli
  ```

Node.js n'est **pas requis** : le frontend utilise du HTML, du CSS et du JavaScript vanilla, sans bundler ni gestionnaire de paquets frontend.

### Récupération du projet

Depuis le répertoire du projet :

```bash
cd SoundMap
```

Vérifiez ensuite que les fichiers frontend référencés par `src-tauri/tauri.conf.json` sont bien présents dans le répertoire configuré pour le frontend.

## Utilisation

Lancer SoundMap en mode développement :

```bash
cargo tauri dev
```

Construire une version distribuable :

```bash
cargo tauri build
```

Dans l'application, chargez une image, ajustez la grille avec le curseur de colonnes, activez si nécessaire le maintien du ratio, puis modifiez les paramètres de niveaux de gris, de contraste, de luminosité et de posterization. La prévisualisation est recalculée lorsque les réglages changent.

## Structure du projet

Une organisation simple peut être la suivante :

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

Les chemins exacts peuvent varier selon la configuration Tauri retenue. Le backend expose notamment des commandes Tauri pour charger l'image, appliquer les ajustements et récupérer les données de pixels.

## Licence

Ce projet est sous licence GNU GPL v3. Vous êtes libre d'utiliser, modifier et redistribuer ce code, à condition que toute œuvre dérivée soit également publiée sous GPLv3 avec ses sources. Voir le fichier LICENSE pour le texte complet.
