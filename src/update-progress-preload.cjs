'use strict'

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

const STATE_CHANNEL = 'mengluo:update-progress:state'
const READY_CHANNEL = 'mengluo:update-progress:ready'

contextBridge.exposeInMainWorld('harnessUpdateProgress', Object.freeze({
  onState(listener) {
    if (typeof listener !== 'function') throw new TypeError('progress state listener must be a function')
    const handler = (_event, state) => { listener(state) }
    ipcRenderer.on(STATE_CHANNEL, handler)
    ipcRenderer.send(READY_CHANNEL)
    return () => { ipcRenderer.removeListener(STATE_CHANNEL, handler) }
  },
}))
