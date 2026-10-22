const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("auraDesktop", {
  toggleListening() {
    ipcRenderer.send("aura:toggle-listening");
  },

  onToggleListening(callback) {
    const handler = () => callback();
    ipcRenderer.on("aura:toggle-listening", handler);

    return () => {
      ipcRenderer.removeListener("aura:toggle-listening", handler);
    };
  },
});