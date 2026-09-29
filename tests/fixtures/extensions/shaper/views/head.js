// A canvas-header view (1.6), by hand: it shows the canvas it was given and runs a command with it.
;(function () {
  const send = (msg) => window.parent.postMessage(Object.assign({ devlog: 1 }, msg), '*')
  window.addEventListener('message', (ev) => {
    const m = ev.data
    if (!m || m.devlog !== 1) return
    if (m.type === 'context') document.getElementById('out').textContent = `on ${m.context.canvasId || 'nothing'}`
  })
  document.getElementById('where').addEventListener('click', () => send({ type: 'command', command: 'where' }))
  send({ type: 'resize', width: 160 })
  send({ type: 'ready' })
})()
