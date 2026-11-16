# Third-party notices

Local Workbench's original code is licensed under the MIT license in `LICENSE`.
Third-party dependencies retain their own licenses.

The packaged application includes [`licenses/DEPENDENCY-LICENSES.txt`](licenses/DEPENDENCY-LICENSES.txt)
with available upstream license and NOTICE files from installed production npm
packages and the Windows Rust dependency graph. Regenerate before packaging with
`python scripts/collect-licenses.py`. Native audio capture uses CPAL under its
upstream license; see the dependency inventory for its full notice.

## Markdown rendering

The assistant uses [react-markdown](https://github.com/remarkjs/react-markdown)
and [remark-gfm](https://github.com/remarkjs/remark-gfm), both MIT licensed.
Their dependency license notices remain in the npm packages. Markdown content is
rendered locally; no remote renderer, fonts or CDN is required.

## React Bits — Strands, Lattice Loader, Thought Line and Voice Pill

Copyright © 2026 David Haz.

`src/vendor/strands/`, `src/vendor/lattice-loader/`, `src/vendor/thought-line/` and `src/vendor/voice-pill/` originate from
[React Bits](https://github.com/DavidHDev/react-bits), used as part of this application.
They are licensed under **MIT + Commons Clause**, rather than this project's MIT
license. The complete license is preserved in
[`licenses/react-bits-LICENSE.md`](licenses/react-bits-LICENSE.md).
The app does not sell or distribute these components as a standalone product.
