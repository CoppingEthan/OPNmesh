# OPNmesh branding

The chosen logo is `logo.svg` (concept 6, also `src/ui/logo.tsx` in the app). Logo concepts live in `concepts/` as hand-drawn SVG lockups where the icon
*is* the O of "OPNmesh". `node scripts/brand-preview.mjs` renders each to PNG
(light, dark, and the icon alone at 64/32/16 px) under `concepts/preview/`,
with a contact sheet at `concepts/preview/sheet.png`.

## Palette

| Role | Value | Notes |
|---|---|---|
| Ring and "PN" | `#3fb28c` | the O and the letters share one green |
| Sites and tunnels | `#5ac5a1` | the three dots and the lines between them, a shade lighter |
| Wordmark "mesh" | `#16211d` on light, `#f4f7f5` on dark | ink |

The app's brand token is `#0f8f6e` (light) / `#22b58c` (dark); the logo's
greens are the same hue family, lifted toward pastel as requested.

## Concepts

| File | Idea | Verdict at small sizes |
|---|---|---|
| `concept-1-mesh.svg` | four sites on the ring, every one linked to every other | chords vanish below 32 px |
| `concept-2-links.svg` | two halves meeting end to end | clean at every size; can read as a spinner |
| `concept-3-orbit.svg` | sites orbiting one network | reads as a planet; ring clashes with the P |
| `concept-4-signal.svg` | concentric rings, the tunnel end-on | strong at every size; generic |
| `concept-5-hub.svg` | three sites joined through a hub | good; the Y shape recalls a car badge |
| `concept-6-ring.svg` | three sites joined by three tunnels into one ring | strong at every size; distinctive |

## Finishing the chosen one

The wordmark is live text (`Segoe UI Variable Display` with fallbacks) so it
renders with whatever font the viewer has. The final logo should have the
text converted to outlines so it is identical everywhere, and ship as:

- `logo.svg` (lockup), `logo-dark.svg`
- `icon.svg` (the O alone, square viewBox), plus `favicon.ico` / `icon-192.png` / `icon-512.png`

## Wallpaper

The dashboard background is `public/wallpaper.webp` (with a JPEG fallback
next to it), made from the Unsplash photo `gradient-wallpapers-rcVkESi_JTQ`
by Gradient Wallpapers, scaled to 2000 px and compressed:

```sh
ffmpeg -i source.jpg -vf "scale='min(2000,iw)':-2" -c:v libwebp -quality 72 public/wallpaper.webp
```

The Unsplash licence permits this use; credit is appreciated, not required.
