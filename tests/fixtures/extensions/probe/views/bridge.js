// The view protocol by hand (what @devlog/ui wraps): postMessage to the app, answers come back.
;(function () {
  let next = 1
  const waiting = new Map()
  const listeners = []
  window.addEventListener('message', (ev) => {
    const m = ev.data
    if (!m || m.devlog !== 1) return
    if (m.type === 'theme') {
      for (const [k, v] of Object.entries(m.vars)) document.documentElement.style.setProperty(k, v)
      document.documentElement.dataset.theme = m.dark ? 'dark' : 'light'
    } else if (m.type === 'reply') {
      const w = waiting.get(m.id)
      if (!w) return
      waiting.delete(m.id)
      m.ok ? w.resolve(m.value) : w.reject(new Error(m.error))
    } else if (m.type === 'message') for (const cb of listeners) cb(m.data)
  })
  const send = (msg) => window.parent.postMessage(Object.assign({ devlog: 1 }, msg), '*')
  window.probe = {
    call: (method, ...args) =>
      new Promise((resolve, reject) => {
        const id = next++
        waiting.set(id, { resolve, reject })
        send({ type: 'call', id, method, args })
      }),
    on: (cb) => listeners.push(cb),
    send
  }
  send({ type: 'ready' })
})()
