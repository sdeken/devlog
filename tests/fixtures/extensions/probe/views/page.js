const el = (id) => document.getElementById(id)
window.probe.call('greet', 'page').then((v) => (el('greet').textContent = v))
window.probe.call('fail').then(
  () => (el('fail').textContent = 'no error?'),
  (e) => (el('fail').textContent = `refused: ${e.message}`)
)
// The page cannot reach the network or the window around it.
fetch('https://example.com/').then(
  () => (el('net').textContent = 'network: reachable'),
  () => (el('net').textContent = 'network: blocked')
)
try {
  el('parent').textContent = `parent: ${window.parent.document.title}`
} catch {
  el('parent').textContent = 'parent: blocked'
}
