const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopLanguage', Object.freeze({
  getState: () => ipcRenderer.invoke('mengluo:language:get'),
  onState(listener) {
    if (typeof listener !== 'function') throw new TypeError('language listener must be a function')
    const receive = (_event, state) => listener(state)
    ipcRenderer.on('mengluo:language:state', receive)
    return () => ipcRenderer.removeListener('mengluo:language:state', receive)
  },
}))

contextBridge.exposeInMainWorld('clientUpdate', Object.freeze({
  check: () => ipcRenderer.send('mengluo:client-update:action', 'check'),
  download: () => ipcRenderer.send('mengluo:client-update:action', 'download'),
  install: () => ipcRenderer.send('mengluo:client-update:action', 'install'),
  onState(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    const receive = (_event, state) => listener(state)
    ipcRenderer.on('mengluo:client-update:state', receive)
    ipcRenderer.send('mengluo:client-update:ready')
    return () => ipcRenderer.removeListener('mengluo:client-update:state', receive)
  },
}))
