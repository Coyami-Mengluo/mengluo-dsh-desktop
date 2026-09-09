'use strict'

const { contextBridge, ipcRenderer } = require('electron')

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
