# Tamperward logo

`logo.svg` is the canonical, theme-independent mark. Keep its opaque light badge:
it gives the navy strokes and blue bars a fixed background even when a native app,
image proxy, Markdown renderer, or image export cannot apply SVG media queries.
Only the area outside the rounded badge is transparent.

- `logo.png` is the 512 × 512 raster export used by the repository README. Use it
  for platforms that do not support SVG.
- `../docs/public/logo.svg` is an identical copy for the docs navigation and hero.
- `../docs/public/logo-dark.svg` is retained as an identical compatibility copy
  for existing links; it no longer depends on a particular theme.
- `../docs/public/favicon.svg` uses heavier strokes and a wider central gap for
  small tab icons, with the same badge and fixed colors.

The stroke contrast against the `#f8fafc` badge is approximately 17.1:1 for navy
(`#0f172a`) and 4.9:1 for blue (`#2563eb`). No CSS, scripts, external fonts, or
host-theme detection are needed.

When updating the mark, copy the canonical SVG to both docs logo paths and
regenerate the PNG at 512 × 512 in sRGB with transparency outside the badge.
For example, with Sharp available locally:

```js
import sharp from 'sharp';
await sharp('assets/logo.svg').resize(512, 512).png().toFile('assets/logo.png');
```

Inspect both formats on white, GitHub dark (`#0d1117`), black, and mid-grey
backgrounds; check the favicon at 16 px and the logo at 24, 32, and 76 px.
