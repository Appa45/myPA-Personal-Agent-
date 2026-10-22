
const {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  session,
} = require("electron");

const path = require("path");

let mainWindow = null;
let auraWindow = null;

// Create the main React application window.
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL("http://localhost:5173/");

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("[Electron] Main React app loaded");
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    console.error("[Electron] Main window failed to load:", code, description);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Create the always-on-top floating AURA emoji.
function createAuraWindow() {
  if (auraWindow && !auraWindow.isDestroyed()) {
    return;
  }

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  auraWindow = new BrowserWindow({
    width: 100,
    height: 100,
    x: width - 130,
    y: height - 150,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  auraWindow.setAlwaysOnTop(true);
  auraWindow.loadFile(path.join(__dirname, "floating.html"));

  auraWindow.webContents.on("did-finish-load", () => {
    console.log("[Electron] Floating AURA emoji loaded");
  });

  auraWindow.webContents.on("did-fail-load", (_event, code, description) => {
    console.error("[Electron] Floating window failed to load:", code, description);
  });

  auraWindow.on("closed", () => {
    auraWindow = null;
  });
}

// Receive clicks from the floating emoji and forward them to React.
ipcMain.on("aura:toggle-listening", () => {
  console.log("[Electron] AURA emoji clicked");

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("aura:toggle-listening");
  } else {
    console.log("[Electron] Main window is not available");
  }
});

// Electron must be ready before accessing session.defaultSession.
app.whenReady().then(() => {
  console.log("[Electron] App is ready");

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const url = webContents.getURL();

      const isLocalAura =
        url.startsWith("http://localhost:5173/") ||
        url.startsWith("http://127.0.0.1:5173/");

      if (permission === "media" && isLocalAura) {
        callback(true);
      } else {
        callback(false);
      }
    }
  );

  createMainWindow();
  createAuraWindow();

  console.log("[Electron] Windows created");

  app.on("activate", () => {
    createMainWindow();
    createAuraWindow();
  });
});

// Keep Electron running when windows are closed.
app.on("window-all-closed", () => {
  // Intentionally keep the desktop assistant running.
});

app.on("render-process-gone", (_event, webContents, details) => {
  console.error("[Electron] Renderer process exited:", details);
});

console.log("[Electron] main.cjs loaded");
