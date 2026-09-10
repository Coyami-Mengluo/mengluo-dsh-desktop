'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const STATE_CHANNEL = 'mengluo:titlebar:state'
const READY_CHANNEL = 'mengluo:titlebar:ready'

contextBridge.exposeInMainWorld('harnessWindowControls', Object.freeze({
  minimize() { ipcRenderer.send('mengluo:window-controls:action', 'minimize') },
  toggleMaximize() { ipcRenderer.send('mengluo:window-controls:action', 'toggle-maximize') },
  close() { ipcRenderer.send('mengluo:window-controls:action', 'close') },
  onState(listener) {
    if (typeof listener !== 'function') throw new TypeError('window state listener must be a function')
    const handler = (_event, state) => { listener(state) }
    ipcRenderer.on('mengluo:window-controls:state', handler)
    ipcRenderer.send('mengluo:window-controls:ready')
    return () => { ipcRenderer.removeListener('mengluo:window-controls:state', handler) }
  },
}))

contextBridge.exposeInMainWorld('harnessTitlebar', Object.freeze({
  onState(listener) {
    if (typeof listener !== 'function') throw new TypeError('titlebar state listener must be a function')
    const handler = (_event, state) => { listener(state) }
    ipcRenderer.on(STATE_CHANNEL, handler)
    ipcRenderer.send(READY_CHANNEL)
    return () => { ipcRenderer.removeListener(STATE_CHANNEL, handler) }
  },
}))

contextBridge.exposeInMainWorld('harnessSetup', Object.freeze({
  refresh() { return ipcRenderer.invoke('mengluo:setup:action', { type: 'refresh' }) },
  install(version) { return ipcRenderer.invoke('mengluo:setup:action', { type: 'install', version }) },
  setDownloadSource(source) { return ipcRenderer.invoke('mengluo:setup:action', { type: 'download-source', source }) },
  testConnection() { return ipcRenderer.invoke('mengluo:setup:action', { type: 'test-connection' }) },
  onState(listener) {
    if (typeof listener !== 'function') throw new TypeError('setup listener must be a function')
    const handler = (_event, state) => { listener(state) }
    ipcRenderer.on('mengluo:setup:state', handler)
    ipcRenderer.send('mengluo:setup:ready')
    return () => { ipcRenderer.removeListener('mengluo:setup:state', handler) }
  },
}))
