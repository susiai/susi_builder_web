# Bundled template libraries

This directory stores the Plotly, uPlot, Matter.js, and Three.js bundles for generated projects.
Each script uses the classic-script adapter used by Create App. Generated apps receive the bundle and its license text.

## Plotly basic 4.3.0

- Upstream release: https://github.com/plotly/plotly.js/releases/tag/v4.3.0
- Bundle documentation: https://github.com/plotly/plotly.js/blob/v4.3.0/dist/README.md#plotlyjs-basic
- License: MIT, copyright Plotly, Inc.
- Supported chart traces: `bar`, `pie`, and `scatter` (including line charts).
- This is the official basic bundle, not the complete Plotly distribution. Maps, 3D, and other trace types are omitted.
- The script sets `window.Plotly`; it does not require a package manager or build step.
- Retain the bundled third-party license comments at the end of the script. They include Native Promise Only,
  PolyBool, and object-assign notices. The distributed script is kept intact.

## uPlot 1.6.32

- Upstream release: https://github.com/leeoniya/uPlot/releases/tag/1.6.32
- License: MIT, copyright Leon Sorokin.
- The standalone IIFE script exposes `uPlot`; its stylesheet must also be included.
- The pinned release contains its own MIT license. No separate `LICENSE-ivi` file exists in this release.

## Highlight.js 11.9.0 license

`../js/vendor/highlight-LICENSE.txt` supplies the BSD-3-Clause license for Webstation's existing
`../js/highlight.min.js` distribution.

## Matter.js 0.20.0

The browser bundle exposes `Matter` and is distributed under the MIT license. [Upstream release](https://github.com/liabru/matter-js/releases/tag/0.20.0)

## Three.js r187

The browser bundle exposes `THREE` from the MIT-licensed `three@0.187.0` package.
The bundle combines the release's WebGL modules for direct-file use. [Upstream release](https://github.com/mrdoob/three.js/releases/tag/r187)

The checked-in bundle was produced from the package's `build/three.module.js` with esbuild 0.27.3 using
`--bundle --format=iife --global-name=THREE --minify --target=es2020 --legal-comments=inline`.
Create App and exported apps use the checked-in bundle directly.

## Exact files and checksums

The SHA-256 digests below cover the exact files written into generated projects.

### `plotly-basic-4.3.0.min.js`

Source: https://raw.githubusercontent.com/plotly/plotly.js/v4.3.0/dist/plotly-basic.min.js

Size: 1,204,205 bytes.

SHA-256: `83af6e1515a1652425cb2b7e3392cc42b6008565f5aa037c9203c747a2476dc7`

### `plotly-LICENSE.txt`

Source: https://raw.githubusercontent.com/plotly/plotly.js/v4.3.0/LICENSE

Size: 1,086 bytes.

SHA-256: `8c45d9eaf50c2f72dd9c7ab9ef440788ba58a3538484b5c51c1f17d5128752e7`

### `uPlot-1.6.32.iife.min.js`

Source: https://raw.githubusercontent.com/leeoniya/uPlot/1.6.32/dist/uPlot.iife.min.js

Size: 51,081 bytes.

SHA-256: `19c8d4c6ad88929a79f4ae49d6f7161566dfd0ba3d15cc495e974f787eb78f1f`

### `uPlot-1.6.32.min.css`

Source: https://raw.githubusercontent.com/leeoniya/uPlot/1.6.32/dist/uPlot.min.css

Size: 1,857 bytes.

SHA-256: `df630c6a8d6f8eeaff264b50f73ce5b114f646ffd9a0bb74f049b0a00135fa04`

### `uPlot-LICENSE.txt`

Source: https://raw.githubusercontent.com/leeoniya/uPlot/1.6.32/LICENSE

Size: 1,078 bytes.

SHA-256: `8f989229699b4fe2f1a0432d0e9edc338a8a911e250e2d1b01ecd770a5f5b1bd`

### `../js/vendor/highlight-LICENSE.txt`

Source: https://raw.githubusercontent.com/highlightjs/highlight.js/11.9.0/LICENSE

Size: 1,514 bytes.

SHA-256: `6c081431591d9df696c82dc598fe1423765b8a299b200ed00b281afd0f64c490`

### `matter-0.20.0.min.js`

[Upstream browser bundle](https://raw.githubusercontent.com/liabru/matter-js/0.20.0/build/matter.min.js)

Size: 83,476 bytes.

SHA-256: `72d30be0f579eb02ce1e0b6f9d359a4f392e6837e5a26ba8be5dbee7f88e24ae`

### `matter-LICENSE.txt`

[Upstream license](https://raw.githubusercontent.com/liabru/matter-js/0.20.0/LICENSE)

Size: 1,092 bytes.

SHA-256: `ed182087be5b26734aa6d4789743de3a97417950e8c1e3ff2e3d19c6462720d3`

### `three-r187.iife.min.js`

Size: 749,788 bytes.

SHA-256: `c78895acdff5f794696fc6840893006b8640f1c4adf97fcdc7bc8891aa6d9d06`

### `three-LICENSE.txt`

Size: 1,081 bytes.

SHA-256: `8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc`
