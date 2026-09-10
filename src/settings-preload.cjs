const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('clientSettings', Object.freeze({
  ready: () => ipcRenderer.send('mengluo:settings:ready'),
  action: request => ipcRenderer.invoke('mengluo:settings:action', request),
  onState(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    const receive = (_event, state) => listener(state)
    ipcRenderer.on('mengluo:settings:state', receive)
    return () => ipcRenderer.removeListener('mengluo:settings:state', receive)
  },
}))
