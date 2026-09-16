# Fonts for the link-preview image

The Open Graph image is rendered server-side from SVG, and **fonts do not travel inside an
SVG** — the rasteriser needs the actual files. Without them the image still renders, but in
whatever faces the host happens to have.

Drop these here, with their licence files. All three are OFL, and since this repo is
public the licence text should sit beside the font rather than only be linked:

| File | Used for |
|---|---|
| `Cinzel-Bold.ttf` | the wordmark, the game title, the stat numerals |
| `AlegreyaSans-Bold.ttf` | the small-caps line under the title |
| `IBMPlexMono-Medium.ttf` *(or JetBrains Mono)* | the game id |

`.ttf` and `.otf` here are loaded automatically at first render. Nothing else is read, so
the `OFL-*.txt` files sit alongside harmlessly.

## Use static fonts, not variable ones

**resvg renders a variable font at its default instance and ignores `font-weight`.** Google
Fonts now ships Cinzel *only* as `Cinzel[wght].ttf`, so the title renders at regular weight
and nothing warns you — it just quietly looks wrong, which is worse than failing.

Take the static bold from upstream instead:

```sh
curl -sSL -o Cinzel-Bold.ttf \
  https://github.com/NDISCOVER/Cinzel/raw/master/fonts/ttf/Cinzel-Bold.ttf
```

Alegreya Sans and IBM Plex Mono both still publish static instances in `google/fonts`:

```sh
B=https://raw.githubusercontent.com/google/fonts/main/ofl
curl -sSL -o AlegreyaSans-Bold.ttf  "$B/alegreyasans/AlegreyaSans-Bold.ttf"
curl -sSL -o IBMPlexMono-Medium.ttf   "$B/ibmplexmono/IBMPlexMono-Medium.ttf"
curl -sSL -o OFL-AlegreyaSans.txt     "$B/alegreyasans/OFL.txt"
curl -sSL -o OFL-IBMPlexMono.txt      "$B/ibmplexmono/OFL.txt"
curl -sSL -o OFL-Cinzel.txt           "$B/cinzel/OFL.txt"
```
