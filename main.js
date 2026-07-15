const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('Sticky Notes');

const userDataPath = app.getPath('userData');
const notesFile = path.join(userDataPath, 'notes.json');
const settingsFile = path.join(userDataPath, 'settings.json');

const windows = new Map();
let tray = null;
let searchWin = null;

const DEFAULT_PALETTES = {
  light: ['#FFE56B', '#FF9DC4', '#9DD4FF', '#A8E6A3', '#FFB570', '#D4A8FF', '#FFFFFF'],
  dark:  ['#5A4D1F', '#5D2C44', '#1F3F5C', '#2B5230', '#5C3E22', '#3F2D5C', '#1E1E1E'],
};

const PALETTES = {
  light: [...DEFAULT_PALETTES.light],
  dark:  [...DEFAULT_PALETTES.dark],
};

let settings = { theme: 'light', trayVisible: true };

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    settings = { theme: 'light', trayVisible: true };
  }
  if (!PALETTES[settings.theme]) settings.theme = 'light';
  if (settings.trayVisible === undefined) settings.trayVisible = true;
  if (settings.palettes) {
    if (Array.isArray(settings.palettes.light) && settings.palettes.light.length > 0)
      PALETTES.light = settings.palettes.light;
    if (Array.isArray(settings.palettes.dark) && settings.palettes.dark.length > 0)
      PALETTES.dark = settings.palettes.dark;
  }
}

function saveSettings() {
  try {
    settings.palettes = { light: [...PALETTES.light], dark: [...PALETTES.dark] };
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings', e);
  }
}

function broadcastPalette() {
  for (const [, win] of windows) {
    if (win.isDestroyed()) continue;
    win.webContents.send('theme', {
      theme: settings.theme,
      palette: PALETTES[settings.theme],
      color: win.noteData.color,
    });
  }
}

function paletteIndex(color) {
  for (const palette of Object.values(PALETTES)) {
    const i = palette.indexOf(color);
    if (i !== -1) return i;
  }
  return -1;
}

function switchTheme(newTheme) {
  if (!PALETTES[newTheme] || newTheme === settings.theme) return;
  const oldPalette = PALETTES[settings.theme];
  const newPalette = PALETTES[newTheme];
  settings.theme = newTheme;
  for (const [, win] of windows) {
    if (win.isDestroyed()) continue;
    const idx = oldPalette.indexOf(win.noteData.color);
    if (idx !== -1) {
      win.noteData.color = newPalette[idx];
      win.setBackgroundColor(newPalette[idx]);
    }
    win.webContents.send('theme', {
      theme: newTheme,
      palette: newPalette,
      color: win.noteData.color,
    });
  }
  saveSettings();
  saveNotes();
  buildTrayMenu();
}

function loadNotes() {
  try {
    return JSON.parse(fs.readFileSync(notesFile, 'utf8'));
  } catch {
    return [];
  }
}

function saveNotes() {
  const notes = [];
  for (const [id, win] of windows) {
    if (win.isDestroyed()) continue;
    const bounds = win.getBounds();
    notes.push({
      id,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      color: win.noteData.color,
      text: win.noteData.text,
      pinned: win.isAlwaysOnTop(),
    });
  }
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(notesFile, JSON.stringify(notes, null, 2));
  } catch (e) {
    console.error('Failed to save notes', e);
  }
}

function createNote(data = {}) {
  const id = data.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const palette = PALETTES[settings.theme];
  const color = data.color || palette[palette.length - 1];

  const win = new BrowserWindow({
    width: data.width || 263,
    height: data.height || 260,
    x: data.x,
    y: data.y,
    frame: false,
    resizable: true,
    hasShadow: true,
    alwaysOnTop: data.pinned || false,
    backgroundColor: color,
    minWidth: 180,
    minHeight: 180,
    title: 'Sticky Note',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.noteData = { color, text: data.text || '' };
  win.noteId = id;
  windows.set(id, win);

  win.loadFile('note.html');
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('init', {
      id,
      color,
      text: data.text || '',
      pinned: data.pinned || false,
      theme: settings.theme,
      palette: PALETTES[settings.theme],
    });
  });

  win.on('moved', saveNotes);
  win.on('resized', saveNotes);
  win.on('closed', () => {
    windows.delete(id);
    saveNotes();
  });

  return win;
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function htmlToMarkdown(html) {
  return String(html || '')
    .replace(/<img[^>]*src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)')
    .replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)>(.*?)<\/\1>/gi, '*$2*')
    .replace(/<h1>(.*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2>(.*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3>(.*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<h4>(.*?)<\/h4>/gi, '#### $1\n\n')
    .replace(/<h5>(.*?)<\/h5>/gi, '##### $1\n\n')
    .replace(/<h6>(.*?)<\/h6>/gi, '###### $1\n\n')
    .replace(/<li>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<\/(ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>/gi, '\n\n')
    .replace(/<p[^>]*class="todo done"[^>]*>.*?<span[^>]*class="check"[^>]*><\/span>(.*?)<\/p>/gi, '- [x] $1\n')
    .replace(/<p[^>]*class="todo"[^>]*>.*?<span[^>]*class="check"[^>]*><\/span>(.*?)<\/p>/gi, '- [ ] $1\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildExportHtml(body, noteTitle) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${noteTitle}</title>
</head>
<body>
${body}
</body>
</html>
`;
}

async function saveNoteToFile(win, note = {}) {
  if (!win || win.isDestroyed()) return { canceled: true };
  const html = String(note.html || '');
  const plainText = String(note.text || stripHtml(html));
  const markdown = String(note.markdown || htmlToMarkdown(html));
  const defaultName = `sticky-note-${win.noteId || Date.now()}`;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Note',
    defaultPath: defaultName,
    filters: [
      { name: 'HTML', extensions: ['html', 'htm'] },
      { name: 'Plain Text', extensions: ['txt'] },
      { name: 'Markdown', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (canceled || !filePath) return { canceled: true };

  const ext = path.extname(filePath).toLowerCase();
  let content = plainText;
  if (ext === '.html' || ext === '.htm') {
    content = buildExportHtml(html, defaultName);
  } else if (ext === '.md') {
    content = markdown;
  }

  fs.writeFileSync(filePath, content, 'utf8');
  return { canceled: false, filePath };
}

function requestSaveForFocusedWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused || focused.isDestroyed()) return;
  focused.webContents.send('note:perform-save');
}

function openSearch() {
  if (searchWin && !searchWin.isDestroyed()) {
    if (searchWin.isVisible()) {
      searchWin.hide();
    } else {
      searchWin.show();
      searchWin.focus();
    }
    return;
  }
  searchWin = new BrowserWindow({
    width: 440,
    height: 380,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  searchWin.loadFile('search.html');
  searchWin.once('ready-to-show', () => {
    searchWin.show();
    searchWin.focus();
  });
  searchWin.on('closed', () => {
    searchWin = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: 'Sticky Notes',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Reset to Default Colors',
          click: () => {
            PALETTES.light = [...DEFAULT_PALETTES.light];
            PALETTES.dark  = [...DEFAULT_PALETTES.dark];
            saveSettings();
            broadcastPalette();
          },
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => createNote() },
        { label: 'Save As...', accelerator: 'CmdOrCtrl+S', click: requestSaveForFocusedWindow },
        {
          label: 'Close Note',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow();
            if (focused) focused.close();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find...', accelerator: 'CmdOrCtrl+F', click: openSearch },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus', visible: false },
        { role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        { type: 'separator' },
        {
          label: settings.trayVisible ? 'Hide Menu Bar Icon' : 'Show Menu Bar Icon',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => setTrayVisible(!settings.trayVisible),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function buildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'New Note', accelerator: 'CmdOrCtrl+N', click: () => createNote() },
    { label: 'Search Notes', accelerator: 'CmdOrCtrl+F', click: openSearch },
    {
      label: 'Show All Notes',
      click: () => {
        for (const win of windows.values()) {
          if (!win.isDestroyed()) win.show();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Hide Menu Bar Icon',
      accelerator: 'CmdOrCtrl+Shift+M',
      click: () => setTrayVisible(false),
    },
    {
      label: 'Theme',
      submenu: [
        {
          label: 'Light',
          type: 'radio',
          checked: settings.theme === 'light',
          click: () => switchTheme('light'),
        },
        {
          label: 'Dark',
          type: 'radio',
          checked: settings.theme === 'dark',
          click: () => switchTheme('dark'),
        },
      ],
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setTitle('📝');
  tray.setToolTip('Sticky Notes');
  buildTrayMenu();
}

function setTrayVisible(visible) {
  settings.trayVisible = visible;
  saveSettings();
  if (visible) {
    if (!tray || tray.isDestroyed()) createTray();
  } else if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
  buildMenu();
}

app.whenReady().then(() => {
  loadSettings();
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, 'icon.png'));
    } catch (e) {
      console.error('Failed to set dock icon', e);
    }
  }
  buildMenu();
  if (settings.trayVisible) createTray();
  const saved = loadNotes();
  if (saved.length === 0) {
    createNote();
  } else {
    saved.forEach((n) => createNote(n));
  }

  app.on('activate', () => {
    if (windows.size === 0) createNote();
  });
});

ipcMain.on('note:update', (event, { id, text, color }) => {
  const win = windows.get(id);
  if (!win || win.isDestroyed()) return;
  if (text !== undefined) win.noteData.text = text;
  if (color !== undefined) {
    win.noteData.color = color;
    win.setBackgroundColor(color);
  }
  saveNotes();
});

ipcMain.on('note:new', () => createNote());

ipcMain.handle('note:save-dialog', async (event, note) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return saveNoteToFile(win, note);
});

ipcMain.on('note:delete', (event, id) => {
  const win = windows.get(id);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.on('note:pin', (event, { id, pinned }) => {
  const win = windows.get(id);
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(pinned);
    saveNotes();
  }
});

ipcMain.handle('search:list', () => {
  const list = [];
  for (const [id, win] of windows) {
    if (win.isDestroyed()) continue;
    list.push({
      id,
      color: win.noteData.color,
      text: stripHtml(win.noteData.text),
    });
  }
  return list;
});

ipcMain.on('search:focus', (event, id) => {
  const win = windows.get(id);
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
  }
  if (searchWin && !searchWin.isDestroyed()) searchWin.hide();
});

ipcMain.on('palette:add', (event, color) => {
  PALETTES.light.push(color);
  PALETTES.dark.push(color);
  saveSettings();
  broadcastPalette();
});

ipcMain.on('palette:remove', (event, index) => {
  if (PALETTES.light.length <= 1) return;
  PALETTES.light.splice(index, 1);
  PALETTES.dark.splice(index, 1);
  saveSettings();
  saveNotes();
  broadcastPalette();
});

ipcMain.on('palette:reset', () => {
  PALETTES.light = [...DEFAULT_PALETTES.light];
  PALETTES.dark  = [...DEFAULT_PALETTES.dark];
  saveSettings();
  broadcastPalette();
});

ipcMain.on('search:close', () => {
  if (searchWin && !searchWin.isDestroyed()) searchWin.hide();
});

app.on('window-all-closed', (e) => {
  if (process.platform !== 'darwin') app.quit();
});
