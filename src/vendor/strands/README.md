# React Bits Strands

Vendored from [React Bits Strands](https://reactbits.dev/animations/strands),
`DavidHDev/react-bits/src/ts-default/Animations/Strands`, retrieved 2026-11-15.
Local Workbench uses the upstream refracted sphere from the first frame. A keyboard
input event triggers a short Listening-style envelope; idle motion remains slow.
During a response, seven theme-defined spectrum stops blend in, a positive shader
phase produces a right-to-left wave, and the sphere stays at half size above the
conversation. After the full response completes, the palette blends back to the
selected accent. The shared easing remains cubic-bezier(.22,1,.36,1).

The local renderer caps the decorative shader at 30 fps, smoothly interpolates palettes,
and supports reduced motion. The original ribbon/sphere rendering modes remain available.

Copyright © 2026 David Haz. Licensed under **MIT + Commons Clause**, see
[the complete upstream license](../../../licenses/react-bits-LICENSE.md).
This third-party component is excluded from the application's own MIT grant.
Use is within Local Workbench, not as a standalone component distribution.

The application retains one canvas, warms it during idle time, and parks it offscreen
between pages so shader compilation is not repeated during route animations.
