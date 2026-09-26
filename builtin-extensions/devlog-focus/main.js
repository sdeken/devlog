/**
 * devlog-focus: window tracking as an extension.
 *
 * It runs unrestricted (you are asked whether you trust it), because
 * reading the window in front needs a small platform helper: PowerShell with
 * GetForegroundWindow on Windows, an osascript loop on macOS (window titles
 * need the Accessibility permission), xdotool on Linux if installed.
 *
 * Each change is appended to a JSON-lines file per machine and day in its
 * own folder in the devlog, and handed back to the app's timeline, review
 * and summary:
 *
 *   extensions/builtin.devlog-focus/<machine>/YYYY/MM/YYYY-MM-DD.jsonl
 *   {"t":"2026-09-26T09:14:03.120Z","app":"Code","title":"store.ts — devlog"}
 *
 * Nothing is recorded while the machine is locked or asleep.
 */
const { EventEmitter } = require('node:events')

const FILE_RE = /^([^/]+)\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\.jsonl$/

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function fileFor(machine, iso) {
  const date = localDate(new Date(iso))
  return `${machine}/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.jsonl`
}

// ---------------------------------------------------------------------------
// The platform helper
// ---------------------------------------------------------------------------

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DevlogFG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$last = ''
while ($true) {
  $h = [DevlogFG]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 1024
  [void][DevlogFG]::GetWindowText($h, $sb, 1024)
  $procId = 0
  [void][DevlogFG]::GetWindowThreadProcessId($h, [ref]$procId)
  $name = ''
  if ($procId -ne 0) { $p = Get-Process -Id $procId; if ($p) { $name = $p.ProcessName } }
  $title = $sb.ToString()
  $key = $name + '|' + $title
  if ($key -ne $last) {
    $last = $key
    $o = @{ app = $name; title = $title } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($o)
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 1000
}
`

const MAC_SCRIPT = `
set lastKey to ""
repeat
  set n to ""
  set t to ""
  try
    tell application "System Events"
      set p to first application process whose frontmost is true
      set n to name of p
      try
        set t to name of front window of p
      end try
    end tell
  end try
  set k to n & "|" & t
  if k is not lastKey then
    set lastKey to k
    log k
  end if
  delay 1
end repeat
`

/** Emits `change` with { app, title } whenever the window in front changes. */
class ForegroundWatcher extends EventEmitter {
  constructor() {
    super()
    this.child = null
    this.timer = null
    this.last = null
    this.stopped = true
  }

  start() {
    this.stopped = false
    if (process.platform === 'win32') this.startWindows()
    else if (process.platform === 'darwin') this.startMac()
    else this.startLinux()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.child) {
      this.child.kill()
      this.child = null
    }
  }

  emitChange(info) {
    const key = `${info.app}|${info.title}`
    if (key === this.last) return
    this.last = key
    this.emit('change', info)
  }

  startWindows() {
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')
    this.spawnHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 'stdout', (line) => {
      try {
        const o = JSON.parse(line)
        this.emitChange({ app: String(o.app || ''), title: String(o.title || '') })
      } catch {
        // not a line from the helper
      }
    })
  }

  startMac() {
    this.spawnHelper('osascript', ['-e', MAC_SCRIPT], 'stderr', (line) => {
      const idx = line.indexOf('|')
      if (idx < 0) return
      this.emitChange({ app: line.slice(0, idx), title: line.slice(idx + 1) })
    })
  }

  startLinux() {
    const { execFile } = require('node:child_process')
    const { readFileSync } = require('node:fs')
    execFile('xdotool', ['--version'], (err) => {
      if (err || this.stopped) return
      this.timer = setInterval(() => {
        execFile('xdotool', ['getactivewindow', 'getwindowname', 'getwindowpid'], { timeout: 2000 }, (e, stdout) => {
          if (e) return
          const [title = '', pid = ''] = stdout.split('\n')
          let app = ''
          try {
            app = readFileSync(`/proc/${pid.trim()}/comm`, 'utf8').trim()
          } catch {
            // the process is gone
          }
          this.emitChange({ app, title })
        })
      }, 2000)
    })
  }

  spawnHelper(cmd, args, stream, onLine) {
    const { spawn } = require('node:child_process')
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      return
    }
    this.child = child
    let buf = ''
    child[stream].setEncoding('utf8')
    child[stream].on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line.trim()) onLine(line)
      }
    })
    child.on('error', () => undefined)
    child.on('exit', () => {
      this.child = null
      // Restart after a pause unless told to stop.
      if (!this.stopped) setTimeout(() => !this.stopped && this.start(), 15_000)
    })
  }
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

/**
 * Wire window changes to files and back. `watcher` is anything with
 * start/stop that emits `change` ({ app, title }); tests pass a fake.
 */
function run(ctx, watcher) {
  let last = null
  let paused = false
  let writes = Promise.resolve()

  const record = (t, app, title) => {
    const line = JSON.stringify({ t, app, title }) + '\n'
    // Keep lines in order even if two changes arrive at once.
    writes = writes.then(() => ctx.files.repo.append(fileFor(ctx.machine, t), line)).catch((err) => console.error('devlog-focus: write failed', err))
  }

  watcher.on('change', (w) => {
    // The lock screen and waking up shuffle windows around; that is not work.
    if (paused) return
    last = { app: String(w.app || '').slice(0, 200), title: String(w.title || '').slice(0, 1000) }
    record(new Date().toISOString(), last.app, last.title)
  })

  ctx.activity.on((n) => {
    if (n.type === 'pause' && (n.reason === 'locked' || n.reason === 'suspended')) paused = true
    else if (n.type === 'resume') {
      paused = false
      // Back from a lock, sleep or idle spell: the window in front may not
      // have changed, so say again what it is, or its time would not resume.
      if (last) record(n.t, last.app, last.title)
    }
  })

  ctx.provide.focus(async (fromDate, toDate) => {
    await writes
    const events = []
    for (const f of await ctx.files.repo.list()) {
      const m = FILE_RE.exec(f.path)
      if (!m || m[4] < fromDate || m[4] > toDate) continue
      const text = (await ctx.files.repo.readText(f.path)) || ''
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const o = JSON.parse(line)
          if (typeof o.t === 'string') events.push({ t: o.t, app: String(o.app || ''), title: String(o.title || ''), machine: m[1] })
        } catch {
          // A torn last line (a crash mid-write): skip it.
        }
      }
    }
    return events
  })

  watcher.start()
  return watcher
}

let running = null

exports.activate = (ctx) => {
  running = run(ctx, new ForegroundWatcher())
}

exports.deactivate = () => {
  running?.stop()
  running = null
}

exports.run = run
