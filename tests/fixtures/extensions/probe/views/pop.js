const list = document.getElementById('list')
window.probe.call('canvases').then((cs) => {
  for (const c of cs) {
    const li = document.createElement('li')
    const a = document.createElement('button')
    a.textContent = c.title
    a.addEventListener('click', () => window.probe.send({ type: 'open', canvasId: c.id }))
    li.append(a)
    list.append(li)
  }
})
