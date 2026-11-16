# Voice Pill

Adapted from [React Bits Voice Pill](https://reactbits.dev/micro/voice-pill),
[TypeScript/CSS source](https://github.com/DavidHDev/react-bits/tree/main/src/ts-default/Micro/VoicePill).
Copyright © 2026 David Haz. MIT + Commons Clause, see `licenses/react-bits-LICENSE.md`.

Preserves the expanding capsule, scrolling waveform, timer and stop glyph.
Adaptations: native controlled audio level instead of simulated/Web Audio capture;
Lucide icons already used by the app; theme tokens and SWUST easing; reserved
animated layout width; recognition spinner, cancel action and reduced motion.
Audio and credentials stay in the Tauri layer. This component does not transcribe.
