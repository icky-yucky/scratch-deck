'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// The renderer is served over a custom app:// scheme rather than loaded from file://.
// AudioWorklet requires a secure context with a real origin; file:// pages are treated as
// opaque origins, which is exactly what blocked worklet loading in the browser build.
// Registering the scheme as standard+secure gives the page a proper origin, so
// audioWorklet.addModule() works without needing a local HTTP server at all.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
]);

const RENDERER_DIR = path.join(__dirname, 'renderer');

// Audio is handed to the renderer as an app:// URL it can fetch, rather than as an
// ArrayBuffer cloned across IPC. A whole DJ-length file crossing the boundary as one
// structured clone meant several full copies resident at once; a fetch streams instead.
const AUDIO_ROUTE = '__audio__/';
const LOOP_ROUTE = '__loop__/';

// token -> absolute path, for files the user picked in the native dialog. Bounded, because
// this is a grant of read access and stale grants should not accumulate for the session.
const openedAudio = new Map();
const MAX_AUDIO_GRANTS = 8;

function grantAudio(absPath) {
  const token = crypto.randomUUID();
  openedAudio.set(token, absPath);
  while (openedAudio.size > MAX_AUDIO_GRANTS) {
    openedAudio.delete(openedAudio.keys().next().value);
  }
  return token;
}

// Portable by design: loops live beside the executable so the whole folder can be copied to
// another machine or a USB stick with the library intact. But an installer build can land in
// Program Files, which a standard user cannot write to — and since every file operation
// starts here, that would take the whole loop library down rather than fail one save. So the
// exe-adjacent folder is a preference, not an assumption: probe it, and fall back to
// userData when it is not actually writable.
let cachedLoopsDir = null;

async function isWritable(dir) {
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    await fs.writeFile(probe, '');
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

async function ensureLoopsDir() {
  if (cachedLoopsDir) return cachedLoopsDir;

  const candidates = app.isPackaged
    ? [path.join(path.dirname(app.getPath('exe')), 'loops'), path.join(app.getPath('userData'), 'loops')]
    : [path.join(__dirname, 'loops')];

  for (const dir of candidates) {
    try {
      await fs.mkdir(dir, { recursive: true });
      // access(W_OK) is unreliable for directories on Windows, so actually write something.
      if (await isWritable(dir)) {
        cachedLoopsDir = dir;
        return dir;
      }
    } catch {
      /* try the next candidate */
    }
  }

  const fallback = path.join(app.getPath('userData'), 'loops');
  await fs.mkdir(fallback, { recursive: true });
  cachedLoopsDir = fallback;
  return fallback;
}

// Filenames arrive from the renderer, so treat them as untrusted: strip any path components,
// restrict the charset, refuse names Windows reserves for devices, and force the extension.
// Every resolved path is then re-checked against the loops directory before touching disk.
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function safeName(name) {
  let n = path.basename(String(name || 'loop'));
  n = n.replace(/[^A-Za-z0-9._-]/g, '_');
  n = n.replace(/\.wav$/i, '');
  if (!n || /^\.+$/.test(n)) n = 'loop';
  // CON.wav still resolves to the console device on Windows, so give it a real name.
  if (WINDOWS_RESERVED.test(n)) n = `_${n}`;
  return `${n}.wav`;
}

async function resolveInLoops(name) {
  const dir = await ensureLoopsDir();
  const full = path.join(dir, safeName(name));
  const rel = path.relative(dir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path escapes loops folder');
  return full;
}

// Every operation answers with the same shape — {ok:true, ...} or {ok:false, error} — so the
// renderer has one contract to handle instead of "some of these throw and some return".
const Ops = {
  async list() {
    try {
      const dir = await ensureLoopsDir();
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const wavs = entries.filter((e) => e.isFile() && /\.wav$/i.test(e.name));
      const stats = await Promise.all(
        wavs.map(async (e) => ({ name: e.name, mtime: (await fs.stat(path.join(dir, e.name))).mtimeMs }))
      );
      stats.sort((a, b) => b.mtime - a.mtime); // newest first
      return { ok: true, names: stats.map((s) => s.name) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async save(name, data) {
    try {
      const full = await resolveInLoops(name);
      await fs.writeFile(full, Buffer.from(data));
      return { ok: true, name: path.basename(full) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async rename(from, to) {
    try {
      const src = await resolveInLoops(from);
      const dst = await resolveInLoops(to);
      if (src === dst) return { ok: true, name: path.basename(dst) };

      try {
        await fs.access(src);
      } catch {
        return { ok: false, error: 'not found' };
      }

      // link() fails with EEXIST rather than overwriting, which makes "never clobber" a
      // real guarantee instead of a check that something could slip between.
      try {
        await fs.link(src, dst);
        await fs.unlink(src);
        return { ok: true, name: path.basename(dst) };
      } catch (err) {
        if (err.code === 'EEXIST') return { ok: false, error: 'name already exists' };
        // exFAT USB sticks — the portable use case — have no hard links. Fall back to
        // check-then-rename, which leaves a narrow race no worse than the original.
        if (!['EPERM', 'ENOSYS', 'EXDEV', 'EMLINK', 'ENOTSUP'].includes(err.code)) throw err;
      }

      try {
        await fs.access(dst);
        return { ok: false, error: 'name already exists' };
      } catch { /* free to use */ }
      await fs.rename(src, dst);
      return { ok: true, name: path.basename(dst) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  async remove(name) {
    try {
      const full = await resolveInLoops(name);
      try {
        await fs.unlink(full);
      } catch {
        return { ok: false, error: 'not found' };
      }
      return { ok: true, name: path.basename(full) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
};

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#d4d0c8',
    autoHideMenuBar: true,
    title: 'Scratch Deck',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload imports contextBridge and ipcRenderer only — no fs, no path, no Node —
      // so there is nothing here that needs the Chromium sandbox switched off.
      sandbox: true
    }
  });

  // Content is entirely local. Nothing should be able to navigate the window elsewhere or
  // open a second one; external links go to the user's real browser instead.
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== 'app://scratchdeck') event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL('app://scratchdeck/index.html');
  return win;
}

// Two copies writing the same loops folder is a good way to lose a file. Second launch
// hands focus to the window that already exists.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  start();
}

function start() {
app.whenReady().then(async () => {
  protocol.handle('app', async (request) => {
    let rel;
    try {
      const url = new URL(request.url);
      // A stray % makes this throw; answer with a status rather than a rejected fetch.
      rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (!rel) rel = 'index.html';

    // A file the user picked in the native dialog, addressed by one-time token.
    if (rel.startsWith(AUDIO_ROUTE)) {
      const target = openedAudio.get(rel.slice(AUDIO_ROUTE.length));
      if (!target) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(target).toString());
    }

    // A saved loop, resolved through the same containment check as every other file op.
    if (rel.startsWith(LOOP_ROUTE)) {
      try {
        const full = await resolveInLoops(rel.slice(LOOP_ROUTE.length));
        return net.fetch(pathToFileURL(full).toString());
      } catch {
        return new Response('forbidden', { status: 403 });
      }
    }

    // never serve anything outside the bundled renderer folder
    const full = path.join(RENDERER_DIR, rel);
    const check = path.relative(RENDERER_DIR, full);
    if (check.startsWith('..') || path.isAbsolute(check)) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(full).toString());
  });

  await ensureLoopsDir();

  // ---- loop library ----
  // Kept as plain named functions so the --smoke self-check can exercise the real logic
  // directly instead of reaching into Electron's private handler registry.
  ipcMain.handle('loops:list', () => Ops.list());
  ipcMain.handle('loops:save', (_e, name, data) => Ops.save(name, data));
  ipcMain.handle('loops:rename', (_e, from, to) => Ops.rename(from, to));
  ipcMain.handle('loops:delete', (_e, name) => Ops.remove(name));

  ipcMain.handle('loops:reveal', async () => {
    const dir = await ensureLoopsDir();
    shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('loops:dir', async () => ensureLoopsDir());

  // Native open dialog, so the app can load audio without a browser file input. Returns a
  // URL the renderer fetches rather than the file's bytes.
  ipcMain.handle('audio:open', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Open audio file',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'webm'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    const p = res.filePaths[0];
    return { name: path.basename(p), url: `app://scratchdeck/${AUDIO_ROUTE}${grantAudio(p)}` };
  });

  const win = createWindow();

  // `electron . --smoke` runs a headless self-check and exits with a non-zero code on
  // failure. The important one is the AudioWorklet check: worklet loading is the thing
  // that silently breaks when the page origin is wrong, and it cannot be caught by
  // eyeballing the window.
  if (process.argv.includes('--smoke')) {
    const errors = [];
    // Electron 36+ passes a single event object; older builds passed positional args.
    win.webContents.on('console-message', function (a, b, c) {
      const isEventObj = a && typeof a === 'object' && 'level' in a;
      const level = isEventObj ? a.level : b;
      const message = isEventObj ? a.message : c;
      if (level === 'error' || level === 'warning' || level >= 2) errors.push(String(message));
    });
    win.webContents.once('did-finish-load', async () => {
      let result;
      try {
        result = await win.webContents.executeJavaScript(`(async () => {
          const out = {
            origin: location.origin,
            secureContext: isSecureContext,
            hasLoopAPI: !!window.loopAPI,
            hasAudioAPI: !!window.audioAPI,
            controls: ['playBtn','trackLoopBtn','exportBtn','loopLibrary','renameLoopBtn',
                       'deleteLoopBtn','themeSelect','aboutItem']
                       .filter(id => !document.getElementById(id))
          };
          try {
            const ctx = new AudioContext();
            const src = 'class P extends AudioWorkletProcessor{process(){return true}}' +
                        'registerProcessor("smoke-probe",P)';
            const url = URL.createObjectURL(new Blob([src], {type:'application/javascript'}));
            await ctx.audioWorklet.addModule(url);
            new AudioWorkletNode(ctx, 'smoke-probe');
            out.audioWorklet = 'ok';
            await ctx.close();
          } catch (e) { out.audioWorklet = 'FAILED: ' + e.message; }
          return out;
        })()`);

        // exercise the real file operations end to end, cleaning up after itself
        const wav = new Uint8Array(44).buffer;
        result.ipc = {};
        result.ipc.loopsDir = await ensureLoopsDir();
        result.ipc.dirWritable = await isWritable(result.ipc.loopsDir);
        result.ipc.saved = await Ops.save('__smoke__.wav', wav);
        result.ipc.listedSmoke = (await Ops.list()).names.includes('__smoke__.wav');
        result.ipc.renamed = await Ops.rename('__smoke__.wav', '__smoke2__.wav');
        result.ipc.collisionRefused =
          (await Ops.save('__smoke__.wav', wav)).ok &&
          (await Ops.rename('__smoke__.wav', '__smoke2__.wav')).error === 'name already exists';
        await Ops.remove('__smoke__.wav');
        result.ipc.removed = await Ops.remove('__smoke2__.wav');
        result.ipc.missingHandled = (await Ops.remove('__nope__.wav')).error === 'not found';
        // a traversal attempt must be flattened into the loops folder, not escape it
        const esc = await Ops.save('..\\..\\escaped.wav', wav);
        result.ipc.escapeContained = esc.name === '.._.._escaped.wav' || esc.name === 'escaped.wav';
        await Ops.remove(esc.name);
        // a Windows device name must not survive as one
        const dev = await Ops.save('CON', wav);
        result.ipc.reservedRenamed = dev.ok && dev.name === '_CON.wav';
        await Ops.remove(dev.name);
        // the loop route must serve a saved file and refuse an escape
        await Ops.save('__route__.wav', wav);
        const okRes = await net.fetch(`app://scratchdeck/${LOOP_ROUTE}__route__.wav`);
        result.ipc.loopRouteServes = okRes.status === 200;
        await Ops.remove('__route__.wav');
        result.ipc.cleanedUp = !(await Ops.list()).names.some(n => /__smoke|escaped|__route__|_CON/.test(n));
      } catch (e) {
        result = { fatal: e.message };
      }
      result.consoleErrors = errors;
      console.log('SMOKE_RESULT ' + JSON.stringify(result));
      const bad = result.fatal || result.audioWorklet !== 'ok' ||
                  !result.hasLoopAPI || result.controls.length || errors.length ||
                  !result.ipc.escapeContained || !result.ipc.reservedRenamed ||
                  !result.ipc.loopRouteServes || !result.ipc.cleanedUp;
      app.exit(bad ? 1 : 0);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
