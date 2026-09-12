const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopLanguage', Object.freeze({
  getState: () => ipcRenderer.invoke('mengluo:language:get'),
  setPreference: preference => ipcRenderer.invoke('mengluo:language:set', preference),
  onState(listener) {
    if (typeof listener !== 'function') throw new TypeError('language listener must be a function')
    const receive = (_event, state) => listener(state)
    ipcRenderer.on('mengluo:language:state', receive)
    return () => ipcRenderer.removeListener('mengluo:language:state', receive)
  },
}))

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
