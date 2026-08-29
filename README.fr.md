# SoundMap

*[English version](README.md)*

SoundMap est une application desktop Tauri qui transforme une image en musique. Chargez une image, convertissez-la en grille de pixels, puis laissez un ou plusieurs synthétiseurs lire cette grille pour générer des notes MIDI en temps réel — transformant ainsi couleurs et luminosité en son.

## Fonctionnalités principales

### Traitement d'image

- Chargement d'une image via une boîte de dialogue native.
- Aperçu de l'image originale et de l'image traitée, avec un bouton pour basculer entre les deux.
- Redimensionnement en grille de pixels, où chaque cellule devient une étape de la séquence.
- Ajustement du nombre de colonnes via un slider à échelle logarithmique (la hauteur est déduite automatiquement pour préserver le ratio d'aspect).
- Ajustements de niveaux de gris, contraste, luminosité et postérisation (réduction du nombre de niveaux de couleur/luminosité).
- Réinitialisation de tous les paramètres de traitement.
- Les contrôles d'image sont automatiquement verrouillés pendant qu'un synthétiseur joue, afin de garder la grille de pixels stable pendant la lecture (le bouton « Voir l'original » reste disponible).

### Synthétiseurs

Vous pouvez créer autant de synthétiseurs indépendants que vous le souhaitez, chacun lisant la grille de pixels de façon autonome et envoyant des notes MIDI en temps réel, cadencés par un métronome commun (tempo en BPM).

- **Deux modes de traduction pixel → note, interchangeables pour chaque synthétiseur :**
  - **Monophonique** — la teinte du pixel (cercle chromatique TSL/HSL) détermine une note unique. Un curseur de décalage de teinte (0–360°) permet de faire tourner le cercle chromatique pour ajuster la tonalité dominante du morceau.
  - **Polyphonique** — chaque canal de couleur (Rouge, Vert, Bleu) est lu indépendamment et traduit en sa propre note, formant un accord de 1 à 3 notes. Chaque canal peut être activé ou désactivé individuellement. Survoler les boutons R/V/B affiche la carte d'intensité du canal correspondant directement sur l'image, pour vous aider à choisir les canaux à utiliser.
- **Plage de pixels** — définissez, via un double slider ou en cliquant directement sur deux points de l'image, le pixel de départ et de fin qu'un synthétiseur doit lire.
- **Lecture en boucle ou ponctuelle** — un synthétiseur peut soit boucler indéfiniment sur sa plage de pixels, soit s'arrêter automatiquement une fois la fin atteinte.
- **Seuil de luminosité** — un double slider définit la plage de luminosité qu'un pixel doit respecter pour être audible ; les pixels hors de cette plage sont silencieusement ignorés.
- **Seuil de variation de note** — un écart minimum de teinte/couleur (0 à 12/24 demi-tons) requis entre deux pixels consécutifs pour déclencher une nouvelle note ; sinon, la note en cours est simplement prolongée (legato) plutôt que rejouée.
- **Vélocité minimum** — définit le plancher de la plage de vélocité ; la luminosité du pixel est transposée entre ce plancher et la vélocité maximale (127). Les pixels sombres sont joués plus fort, les pixels clairs plus délicatement.
- **Choix du canal MIDI** par synthétiseur (16 canaux disponibles), verrouillé pendant la lecture.
- **Attribution d'une couleur** à chaque synthétiseur (via un sélecteur de couleurs prédéfinies), utilisée pour surligner sa plage de pixels et sa position de lecture courante directement sur l'image.
- **Bascule de visibilité** du surlignage de plage de pixels, automatiquement masqué pendant la lecture pour n'afficher que le curseur de lecture courant.
- Lecture/arrêt individuel par synthétiseur, ainsi qu'un bouton « tout jouer / tout arrêter » pour l'ensemble de la liste.
- Le métronome commun démarre automatiquement dès qu'un synthétiseur commence à jouer, et s'arrête automatiquement une fois tous les synthétiseurs inactifs.

### Sortie MIDI

- Connexion automatique au premier port de sortie MIDI disponible au démarrage.
- Messages Note On / Note Off en temps réel, avec une gestion propre du legato/sustain (les notes ne sont redéclenchées que lorsqu'elles changent réellement) et une extinction propre des notes à l'arrêt d'un synthétiseur ou lors d'un changement de mode.

## Stack technique

- **Tauri 2** pour l'application desktop et la communication entre le frontend et le backend.
- **Rust 2021** pour le traitement d'image, l'état de l'application et la génération MIDI en temps réel.
- **HTML, SCSS/CSS et JavaScript vanilla** pour l'interface utilisateur, sans framework ni bundler frontend.
- Crates Rust pertinentes :
  - [`tauri`](https://crates.io/crates/tauri) et [`tauri-plugin-dialog`](https://crates.io/crates/tauri-plugin-dialog) pour l'application et les boîtes de dialogue natives ;
  - [`image`](https://crates.io/crates/image) pour le chargement et le traitement d'images ;
  - [`midir`](https://crates.io/crates/midir) pour la sortie MIDI en temps réel ;
  - [`serde`](https://crates.io/crates/serde) et [`serde_json`](https://crates.io/crates/serde_json) pour l'échange de données entre le frontend et le backend ;
  - [`base64`](https://crates.io/crates/base64) pour l'envoi des aperçus PNG au frontend.

## Installation

### Prérequis

- [Rust](https://www.rust-lang.org/tools/install), avec Cargo.
- Les dépendances système requises par Tauri sur votre plateforme.
- Le CLI Tauri :

  ```bash
  cargo install tauri-cli
  ```

Node.js **n'est pas requis** : le frontend utilise du HTML, CSS et JavaScript vanilla, sans bundler ni gestionnaire de paquets frontend.

### Récupérer le projet

Depuis le répertoire du projet :

```bash
cd soundmap
```

## Utilisation

Lancer SoundMap en mode développement :

```bash
cargo tauri dev
```

Construire une version distribuable :

```bash
cargo tauri build
```

Dans l'application :

1. Chargez une image et ajustez la taille de la grille, les niveaux de gris, le contraste, la luminosité et la postérisation. L'aperçu se met à jour en direct.
2. Ajoutez un ou plusieurs synthétiseurs, choisissez un canal MIDI et une couleur pour chacun.
3. Configurez pour chaque synthétiseur sa plage de pixels, son mode de traduction (monophonique/polyphonique), son seuil de luminosité, son seuil de variation de note et sa vélocité minimum.
4. Appuyez sur Play sur un synthétiseur (ou « tout jouer ») pour commencer à entendre votre image.

## Structure du projet

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

Le backend expose des commandes Tauri pour charger les images, appliquer les ajustements, récupérer les données de pixels, gérer les synthétiseurs (création, lecture, canal MIDI, mode, plages, seuils, vélocité) et piloter le métronome commun.

## Licence

Ce projet est distribué sous licence GNU GPL v3. Vous êtes libre d'utiliser, de modifier et de redistribuer ce code, à condition que toute œuvre dérivée soit également publiée sous GPLv3 avec ses sources. Voir le fichier [LICENSE](LICENSE) pour le texte complet.
