# Fonts for the link-preview image

The Open Graph image is rendered server-side from SVG, and **fonts do not travel inside an
SVG** — the rasteriser needs the actual files. Without them the image still renders, but in
whatever faces the host happens to have rather than the ones it was designed in.

Drop these here, along with their licence files:

| File | Used for |
|---|---|
| `Cinzel-Bold.ttf` | the wordmark, the game title, the stat numerals |
| `AlegreyaSans-Bold.ttf` | the small caps line under the title |
| `JetBrainsMono-Medium.ttf` *(or IBM Plex Mono)* | the game id |

All three are OFL. Since this repo is public, check the `OFL.txt` for each one in beside
the font rather than only linking to it.

`.ttf` and `.otf` here are loaded automatically at first render. Nothing else is read.
