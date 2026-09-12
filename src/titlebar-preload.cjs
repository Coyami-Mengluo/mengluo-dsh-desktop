'use strict'

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
  testConnection(version) { return ipcRenderer.invoke('mengluo:setup:action', { type: 'test-connection', ...(version === undefined ? {} : { version }) }) },
  onState(listener) {
    if (typeof listener !== 'function') throw new TypeError('setup listener must be a function')
    const handler = (_event, state) => { listener(state) }
    ipcRenderer.on('mengluo:setup:state', handler)
    ipcRenderer.send('mengluo:setup:ready')
    return () => { ipcRenderer.removeListener('mengluo:setup:state', handler) }
  },
}))
