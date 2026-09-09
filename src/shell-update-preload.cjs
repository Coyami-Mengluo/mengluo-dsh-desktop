const { contextBridge, ipcRenderer } = require('electron')

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
