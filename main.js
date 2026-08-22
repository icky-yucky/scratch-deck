'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
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

// Portable by design: loops live beside the executable so the whole folder can be copied
// to another machine or a USB stick with the library intact. In dev there is no exe, so
// fall back to the project folder.
function loopsDir() {
  return app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), 'loops')
    : path.join(__dirname, 'loops');
}

async function ensureLoopsDir() {
  const dir = loopsDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// Filenames arrive from the renderer, so treat them as untrusted: strip any path
// components, restrict the charset, and force the extension. Every resolved path is then
// re-checked against the loops directory before any file operation touches disk.
function safeName(name) {
  let n = path.basename(String(name || 'loop'));
  n = n.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!/\.wav$/i.test(n)) n += '.wav';
  return n;
}

async function resolveInLoops(name) {
  const dir = await ensureLoopsDir();
  const full = path.join(dir, safeName(name));
  const rel = path.relative(dir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('path escapes loops folder');
  return full;
}

const Ops = {
  async list() {
    const dir = await ensureLoopsDir();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const wavs = entries.filter((e) => e.isFile() && /\.wav$/i.test(e.name));
    const stats = await Promise.all(
      wavs.map(async (e) => ({ name: e.name, mtime: (await fs.stat(path.join(dir, e.name))).mtimeMs }))
    );
    stats.sort((a, b) => b.mtime - a.mtime); // newest first
    return stats.map((s) => s.name);
  },
  async save(name, data) {
    const full = await resolveInLoops(name);
    await fs.writeFile(full, Buffer.from(data));
    return { ok: true, name: path.basename(full) };
  },
  async read(name) {
    const full = await resolveInLoops(name);
    const buf = await fs.readFile(full);
    // a plain ArrayBuffer slice, so the renderer can pass it straight to decodeAudioData
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
  async rename(from, to) {
    const src = await resolveInLoops(from);
    const dst = await resolveInLoops(to);
    try {
      await fs.access(src);
    } catch {
      return { ok: false, error: 'not found' };
    }
    try {
      await fs.access(dst);
      return { ok: false, error: 'name already exists' }; // never silently clobber
    } catch { /* free to use */ }
    await fs.rename(src, dst);
    return { ok: true, name: path.basename(dst) };
  },
  async remove(name) {
    const full = await resolveInLoops(name);
    try {
      await fs.unlink(full);
    } catch {
      return { ok: false, error: 'not found' };
    }
    return { ok: true, name: path.basename(full) };
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
      sandbox: false
    }
  });
  win.loadURL('app://scratchdeck/index.html');
  return win;
}

app.whenReady().then(async () => {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const full = path.join(RENDERER_DIR, rel);
    // never serve anything outside the bundled renderer folder
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
  ipcMain.handle('loops:read', (_e, name) => Ops.read(name));
  ipcMain.handle('loops:rename', (_e, from, to) => Ops.rename(from, to));
  ipcMain.handle('loops:delete', (_e, name) => Ops.remove(name));

  ipcMain.handle('loops:reveal', async () => {
    const dir = await ensureLoopsDir();
    shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('loops:dir', async () => ensureLoopsDir());

  // Native open dialog, so the app can load audio without a browser file input.
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
    const buf = await fs.readFile(p);
    return {
      name: path.basename(p),
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    };
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
        result.ipc.saved = await Ops.save('__smoke__.wav', wav);
        result.ipc.listedSmoke = (await Ops.list()).includes('__smoke__.wav');
        result.ipc.readBytes = (await Ops.read('__smoke__.wav')).byteLength;
        result.ipc.renamed = await Ops.rename('__smoke__.wav', '__smoke2__.wav');
        result.ipc.collisionRefused =
          (await Ops.save('__smoke__.wav', wav)) &&
          (await Ops.rename('__smoke__.wav', '__smoke2__.wav')).error === 'name already exists';
        await Ops.remove('__smoke__.wav');
        result.ipc.removed = await Ops.remove('__smoke2__.wav');
        result.ipc.missingHandled = (await Ops.remove('__nope__.wav')).error === 'not found';
        // a traversal attempt must be flattened into the loops folder, not escape it
        const esc = await Ops.save('..\\..\\escaped.wav', wav);
        result.ipc.escapeContained = esc.name === '.._.._escaped.wav' || esc.name === 'escaped.wav';
        await Ops.remove(esc.name);
        result.ipc.cleanedUp = !(await Ops.list()).some(n => /__smoke|escaped/.test(n));
      } catch (e) {
        result = { fatal: e.message };
      }
      result.consoleErrors = errors;
      console.log('SMOKE_RESULT ' + JSON.stringify(result));
      const bad = result.fatal || result.audioWorklet !== 'ok' ||
                  !result.hasLoopAPI || result.controls.length || errors.length;
      app.exit(bad ? 1 : 0);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
