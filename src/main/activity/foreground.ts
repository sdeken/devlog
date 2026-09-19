/**
 * Foreground-window watcher. Emits `change` with `{ app, title }` whenever
 * the focused window changes. Uses a single long-running helper process per
 * platform rather than a native module:
 *
 *  - Windows: PowerShell + user32 (GetForegroundWindow / GetWindowText).
 *  - macOS:   osascript loop over System Events (window titles need the
 *             Accessibility permission; app names work without).
 *  - Linux:   xdotool polling, if installed.
 */
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'

export interface ForegroundInfo {
  app: string
  title: string
}

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

export class ForegroundWatcher extends EventEmitter {
  private child: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private last: string | null = null
  private stopped = true
  /** Whether this platform can report the foreground window at all. */
  available = false

  start(): void {
    this.stopped = false
    if (process.platform === 'win32') this.startWindows()
    else if (process.platform === 'darwin') this.startMac()
    else this.startLinux()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.child) {
      this.child.kill()
      this.child = null
    }
  }

  private emitChange(info: ForegroundInfo): void {
    const key = `${info.app}|${info.title}`
    if (key === this.last) return
    this.last = key
    this.emit('change', info)
  }

  private startWindows(): void {
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')
    this.spawnHelper('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 'stdout', (line) => {
      try {
        const o = JSON.parse(line) as { app?: string; title?: string }
        this.emitChange({ app: String(o.app ?? ''), title: String(o.title ?? '') })
      } catch {
        /* ignore */
      }
    })
  }

  private startMac(): void {
    this.spawnHelper('osascript', ['-e', MAC_SCRIPT], 'stderr', (line) => {
      const idx = line.indexOf('|')
      if (idx < 0) return
      this.emitChange({ app: line.slice(0, idx), title: line.slice(idx + 1) })
    })
  }

  private startLinux(): void {
    execFile('xdotool', ['--version'], (err) => {
      if (err || this.stopped) return
      this.available = true
      this.timer = setInterval(() => {
        execFile('xdotool', ['getactivewindow', 'getwindowname', 'getwindowpid'], { timeout: 2000 }, (e, stdout) => {
          if (e) return
          const [title = '', pid = ''] = stdout.split('\n')
          let app = ''
          try {
            app = readFileSync(`/proc/${pid.trim()}/comm`, 'utf8').trim()
          } catch {
            /* ignore */
          }
          this.emitChange({ app, title })
        })
      }, 2000)
    })
  }

  private spawnHelper(cmd: string, args: string[], stream: 'stdout' | 'stderr', onLine: (line: string) => void): void {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      return
    }
    this.child = child
    this.available = true
    let buf = ''
    child[stream]?.setEncoding('utf8')
    child[stream]?.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line.trim()) onLine(line)
      }
    })
    child.on('error', () => {
      this.available = false
    })
    child.on('exit', () => {
      this.child = null
      // Restart after a pause unless we were told to stop.
      if (!this.stopped) setTimeout(() => !this.stopped && this.start(), 15_000)
    })
  }
}
