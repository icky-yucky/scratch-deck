# Scratch Deck v0.2

Historical checkpoint. Browser build — run `serve.ps1` (PowerShell) then open
`http://localhost:8000`. `AudioWorklet` requires a real origin, so this cannot be
opened directly as a `file://` page.

## What changed since v0.1

- **Ground-up audio engine rewrite: WSOLA** (Waveform Similarity Overlap-Add). Pitch and
  tempo are now fully decoupled — speed changes no longer bend pitch, unlike v0.1's
  resampling engine. Verified: identical pitch at every drag speed including a full stop,
  unity gain, no tremolo.
- Loop export to WAV with a name prompt
- Saved-loop library: Load / Rename / Delete, backed by `serve.ps1`'s file API
- Whole-track Repeat toggle (an armed A/B loop still takes precedence)
- Help → About dialog

## Carried over from v0.1

Fixed center needle, 1:1 pointer scrubbing, A/B loop markers, pinch/wheel zoom, three
themes (Windows 2000, Windows 2000 Night, Midnight Blue).

## Superseded by

**v0.3** — packaged as a standalone Electron Windows app. No local server needed; the
renderer is served over a secure custom `app://` origin instead, and the loop library
goes through native IPC file operations instead of HTTP.

## Note on the loop library

This checkpoint's actual saved loops (real audio recordings) are intentionally not
included here — only the app source. `loops/` is present as an empty folder the app
writes into.
