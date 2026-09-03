# Scratch Deck

A waveform scrubbing deck: drag the waveform with a mouse or finger to play forward or
backward at whatever speed you drag, with **pitch locked** — no chipmunk/slowdown warping,
just tempo change, like DJ software "key lock." Hold still and the note sustains.

Packaged as a standalone Windows desktop app with Electron.

## Highlights

- **WSOLA time-stretching audio engine** — pitch and tempo are fully decoupled. Verified:
  identical pitch across every drag speed including a full stop, unity gain (no tremolo).
- **1:1 pointer-driven scrubbing** — velocity measured over a smoothed window (not
  consecutive-event deltas, which are dominated by event-timing jitter)
- Fixed center needle; the waveform scrolls beneath it, like Serato/Traktor
- A/B loop markers + whole-track repeat toggle
- Loop export to WAV, with a save/rename/delete library
- Three themes: Windows 2000, Windows 2000 (Night), and a flat dark-blue theme
- Native file dialogs and a portable `loops/` folder that travels with the `.exe`

## Development

```bash
npm install
npm start
```

## Building

```bash
npm run dist
```

Produces an NSIS installer and a portable `.exe` in `dist/`.

## Where loops are saved

The `loops/` folder sits beside the executable, so a portable copy on a USB stick keeps its
library when it moves between machines. If that folder is not writable — an installed build
placed in `Program Files`, for example — the app falls back to your user data directory
rather than failing every save. **Loop library → Show folder** opens whichever one is in use.

## Architecture notes

- The renderer is served over a custom `app://` scheme (registered as a secure origin)
  rather than `file://`. `AudioWorklet` requires a secure context, and `file://` pages are
  treated as an opaque origin in Chromium — that's what blocks worklet loading if you try
  to open the HTML directly in a browser.
- Loop save/rename/delete go through `contextBridge` + IPC to the main process, which
  validates every filename (sanitized charset, forced extension, Windows device names
  refused, and re-checked against the loops directory) before touching disk.
- Reading audio does *not* go over IPC. The main process hands back an `app://` URL — a
  one-time token for a file picked in the dialog, or a contained path for a saved loop — and
  the renderer fetches it. Cloning a DJ-length file across the IPC boundary meant several
  full copies resident at once; a fetch streams instead.
- The renderer runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration:
  false`. The preload imports `contextBridge` and `ipcRenderer` and nothing else, so there is
  no Node surface the sandbox would have to be relaxed for.
- Navigation is pinned to the app's own origin and `window.open` is denied; external links
  open in the user's real browser.

## License

Scratch Deck's own source is [MIT](LICENSE).

The packaged Windows builds also ship the Electron runtime, which embeds
Chromium and Node.js under their own licenses. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for what is redistributed and
where the full notice files land in an installed copy.
