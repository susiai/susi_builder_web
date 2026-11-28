# Create an app icon and SVG favicon

**Find this skill for** app icon, app.svg, app.png, favicon, favicon.svg, browser tab icon, logo, App-Symbol, Browser-Tab.

Start in the selected app folder. Check `index.html`, existing icon files, and the app's colors before choosing a
design. Use a square canvas, a single recognizable shape, and enough contrast and padding for the shape to stay
clear at small sizes.

## Add artwork to the SUSI Builder app tile

- Use `app.svg` for a vector icon. Save it as a standalone SVG file beside `index.html`. Include the SVG namespace
  and a square `viewBox`. Keep the artwork self-contained with local shapes or paths and explicit colors.
- Use `app.png` for raster artwork. Export a square PNG, such as 256 × 256 pixels, with transparency if appropriate.
  In Explorer, use the app folder's **Upload files** action to place the PNG beside `index.html`.

Builder uses the first file it finds. It checks for `app.svg` first, then `app.png`, then `favicon.svg`. To switch
a tile to PNG, rename the existing `app.svg` to keep it as an editable source. If the tile shows initials, check
the filename, folder, and whether the first matching file opens as an image.

## Set an SVG favicon for the browser tab

Save the browser tab icon as `favicon.svg` beside `index.html`. Use the same mark as the app artwork and simplify
fine detail until it reads at 16 × 16 pixels on light and dark tab bars. Add or update the icon link in the HTML
`<head>`.

```html
<link rel="icon" type="image/svg+xml" href="./favicon.svg" sizes="any">
```

On a page one folder deeper, use `../favicon.svg`. If `favicon.svg` is the only icon file, Builder also uses it
for the app tile.

This example is a complete SVG that can be saved as either `app.svg` or `favicon.svg`. Adapt its shape and colors
to the app.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect x="2" y="2" width="28" height="28" rx="7" fill="#193352"/>
  <path d="M9 16l5 5 9-10" fill="none" stroke="#d7ff99" stroke-width="3"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

## Verify both icons

Refresh **Apps** and check the app tile. Open the exported or published app directly in its own browser tab and
check its favicon there. The Builder preview tab displays the preview page's icon. If the browser still shows an
older favicon, try a hard reload.
