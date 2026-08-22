# Scratch Deck v0.1

Historical checkpoint. Browser build, run via a local static server (`AudioWorklet`
requires a real origin — `file://` pages are opaque origins in Chromium and will not
load worklet modules).

## What this checkpoint has

- Fixed center needle; the waveform scrolls beneath it
- 1:1 pointer-driven scrubbing (mouse, touch, pen) with drift-corrected velocity tracking
- Natural-rate hold-to-sustain: stop dragging and the note holds instead of cutting out
- A/B loop markers, pinch-to-zoom, wheel zoom, shift+drag pan
- Three themes: Windows 2000, Windows 2000 (Night), Midnight Blue

## What it does NOT have yet

- No pitch-locked time-stretching — the audio engine here resamples, so speed changes
  bend pitch (WSOLA replaced this in v0.2)
- No loop export or saved-loop library
- No About dialog

## Superseded by

- **v0.2** — ground-up WSOLA audio engine rewrite (pitch/tempo decoupled) + loop
  export/rename/delete library + About dialog
- **v0.3** — packaged as a standalone Electron Windows app
