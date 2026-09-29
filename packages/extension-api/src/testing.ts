/**
 * An in-memory `ctx` for unit-testing an extension without Devlog.
 *
 * ```ts
 * import { createTestContext } from '@devlog/extension-api/testing'
 * import * as ext from '../src/main'
 *
 * const t = createTestContext({ settings: { greeting: 'Hi' } })
 * await ext.activate(t.ctx)
 * await t.run('hello')
 * expect(t.notifications).toEqual(['Hi #1'])
 * ```
 *
 * It follows the real rules where they matter to an extension: files are
 * reached by relative paths only, reads and writes respect the grant you
 * give it, and blocks it adds are marked as its own.
 */
import { API_VERSION, type ActivityNotice, type DevlogContext, type ExtensionBlock, type ExtensionCanvas, type ExtensionFileInfo, type ExtensionFiles, type Destination, type DestinationLine, type DestinationSheet, type FocusEvent, type SendResult } from './index'

export interface TestCanvas extends ExtensionCanvas {
  /** Blocks by date. */
  days?: Record<string, ExtensionBlock[]>
}

export interface TestOptions {
  id?: string
  /** `ctx.machine`. Default `test-machine-0000`. */
  machine?: string
  /** `ctx.packageDir`. Default null (sandboxed). */
  packageDir?: string | null
  canvases?: TestCanvas[]
  settings?: Record<string, string>
  secrets?: Record<string, string>
  /** Canvas ids it may read (with what is beneath them), or 'all'. Default: all. */
  read?: string[] | 'all' | null
  /** Canvas ids it may write to, or 'all'. Default: all. */
  write?: string[] | 'all' | null
  /** Answer for ui.confirm. Default true. */
  confirm?: boolean
  now?: () => Date
}

export interface TestHarness {
  ctx: DevlogContext
  /** Messages passed to ui.notify, in order. */
  notifications: string[]
  /** Questions passed to ui.confirm. */
  confirmations: string[]
  /** Blocks added through devlog.addBlock. */
  added: Array<{ canvasId: string; date: string; block: ExtensionBlock }>
  /** The two private folders, as path → content. */
  files: { repo: Map<string, Uint8Array>; local: Map<string, Uint8Array> }
  secrets: Map<string, string>
  /** Run a registered command. */
  run(commandId: string): Promise<void>
  /** Deliver an activity notice to listeners. */
  notice(n: ActivityNotice): void
  /** Change devlog-wide settings (listeners are told). */
  setSettings(s: Record<string, string>): void
  /** Ask a registered destination for its preview, as the Send dialog would. */
  preview(destinationId: string, sheet: DestinationSheet): Promise<DestinationLine[]>
  /** Send through a registered destination. */
  send(destinationId: string, sheet: DestinationSheet): Promise<SendResult>
  /** Ask the registered focus provider, as the app's views would. */
  focus(fromDate: string, toDate: string): Promise<FocusEvent[]>
  commands(): string[]
}

function checkPath(p: string, allowRoot = false): string {
  const t = String(p).replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (t === '' && allowRoot) return ''
  if (!t || t.startsWith('/') || /^[A-Za-z]:/.test(t) || t.includes('\\') || t.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Not allowed in a path: ${p}`)
  }
  return t
}

function memoryFiles(store: Map<string, Uint8Array>, now: () => Date): ExtensionFiles {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const info = (p: string, b: Uint8Array): ExtensionFileInfo => ({ path: p, size: b.byteLength, mtime: now().toISOString() })
  return {
    read: async (p) => store.get(checkPath(p)),
    readText: async (p) => {
      const b = store.get(checkPath(p))
      return b === undefined ? undefined : dec.decode(b)
    },
    write: async (p, data) => {
      store.set(checkPath(p), typeof data === 'string' ? enc.encode(data) : new Uint8Array(data))
    },
    append: async (p, text) => {
      const k = checkPath(p)
      const cur = store.get(k) ?? new Uint8Array()
      const add = enc.encode(String(text))
      const next = new Uint8Array(cur.byteLength + add.byteLength)
      next.set(cur)
      next.set(add, cur.byteLength)
      store.set(k, next)
    },
    list: async (dir = '') => {
      const d = checkPath(dir, true)
      return [...store.entries()]
        .filter(([k]) => !d || k.startsWith(`${d}/`))
        .map(([k, b]) => info(k, b))
        .sort((a, b) => a.path.localeCompare(b.path))
    },
    stat: async (p) => {
      const k = checkPath(p)
      const b = store.get(k)
      return b ? info(k, b) : undefined
    },
    remove: async (p) => {
      store.delete(checkPath(p))
    }
  }
}

export function createTestContext(opts: TestOptions = {}): TestHarness {
  const id = opts.id ?? 'test.extension'
  const now = opts.now ?? ((): Date => new Date())
  const canvases = opts.canvases ?? []
  let settings = { ...(opts.settings ?? {}) }
  const settingsListeners: Array<(s: Record<string, string>) => void> = []
  const activityListeners: Array<(n: ActivityNotice) => void> = []
  const commandMap = new Map<string, () => void | Promise<void>>()
  let focusProvider: ((from: string, to: string) => Promise<FocusEvent[]>) | null = null
  const destinationMap = new Map<string, Destination>()
  const destination = (id: string): Destination => {
    const d = destinationMap.get(id)
    if (!d) throw new Error(`No destination "${id}"`)
    return d
  }
  const h: Omit<TestHarness, 'ctx'> & { ctx?: DevlogContext } = {
    notifications: [],
    confirmations: [],
    added: [],
    files: { repo: new Map(), local: new Map() },
    secrets: new Map(Object.entries(opts.secrets ?? {})),
    run: async (commandId) => {
      const fn = commandMap.get(commandId)
      if (!fn) throw new Error(`No command "${commandId}"`)
      await fn()
    },
    notice: (n) => {
      for (const cb of activityListeners) cb(n)
    },
    setSettings: (s) => {
      settings = { ...s }
      for (const cb of settingsListeners) cb(settings)
    },
    commands: () => [...commandMap.keys()],
    preview: (id, sheet) => destination(id).preview(sheet),
    send: (id, sheet) => destination(id).send(sheet),
    focus: async (from, to) => {
      if (!focusProvider) throw new Error('No focus provider registered')
      return focusProvider(from, to)
    }
  }

  const within = (scope: string[] | 'all' | null | undefined, canvasId: string): boolean => {
    if (scope === undefined || scope === 'all') return true
    if (!scope) return false
    const byId = new Map(canvases.map((c) => [c.id, c]))
    let cur = byId.get(canvasId)
    const seen = new Set<string>()
    if (scope.includes(canvasId)) return true
    while (cur?.parentId && !seen.has(cur.id)) {
      seen.add(cur.id)
      if (scope.includes(cur.parentId)) return true
      cur = byId.get(cur.parentId)
    }
    return false
  }
  const canvas = (canvasId: string): TestCanvas => {
    const c = canvases.find((x) => x.id === canvasId)
    if (!c) throw new Error('No access to that canvas')
    return c
  }

  h.ctx = {
    id,
    apiVersion: API_VERSION,
    machine: opts.machine ?? 'test-machine-0000',
    packageDir: opts.packageDir ?? null,
    devlog: {
      canvases: async () => canvases.filter((c) => within(opts.read, c.id) || within(opts.write, c.id)).map(({ days: _d, ...c }) => ({ ...c, fields: { ...c.fields } })),
      field: async (canvasId, key) => {
        let cur: TestCanvas | undefined = canvas(canvasId)
        const seen = new Set<string>()
        while (cur && !seen.has(cur.id)) {
          seen.add(cur.id)
          if (cur.fields[key]) return cur.fields[key]
          cur = cur.parentId ? canvases.find((c) => c.id === cur!.parentId) : undefined
        }
        return null
      },
      days: async (canvasId) => {
        if (!within(opts.read, canvasId)) throw new Error('No read access to that canvas')
        return Object.keys(canvas(canvasId).days ?? {}).sort()
      },
      blocks: async (canvasId, date) => {
        if (!within(opts.read, canvasId)) throw new Error('No read access to that canvas')
        return [...(canvas(canvasId).days?.[date] ?? [])]
      },
      search: async (query) => {
        const q = query.toLowerCase()
        const blocks: Array<{ canvasId: string; date: string; block: ExtensionBlock }> = []
        for (const c of canvases) {
          if (!within(opts.read, c.id)) continue
          for (const [date, list] of Object.entries(c.days ?? {})) for (const b of list) if (b.markdown.toLowerCase().includes(q)) blocks.push({ canvasId: c.id, date, block: b })
        }
        return { blocks }
      },
      addBlock: async (canvasId, markdown, o) => {
        if (!within(opts.write, canvasId)) throw new Error('No write access to that canvas')
        const at = now()
        const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
        const day = o?.parentId && o.date ? o.date : date
        const block: ExtensionBlock = {
          id: `b${h.added.length + 1}`,
          createdAt: at.toISOString(),
          markdown: markdown.trim(),
          meta: { ext: id, ...(o?.meta ?? {}) },
          ...(o?.parentId ? { parentId: o.parentId } : {}),
          ...(o?.todo ? { kind: 'todo' } : {})
        }
        const c = canvases.find((x) => x.id === canvasId)
        if (c) (c.days ??= {})[day] = [...(c.days[day] ?? []), block]
        h.added.push({ canvasId, date: day, block })
        return { date: day, block }
      },
      todos: async (o) => {
        const out: Array<{ canvasId: string; date: string; block: ExtensionBlock; trail: Array<{ id: string; title: string }> }> = []
        for (const c of canvases) {
          if (!within(opts.read, c.id)) continue
          for (const [date, list] of Object.entries(c.days ?? {})) {
            for (const b of list) {
              if (b.kind !== 'todo') continue
              const done = b.meta?.done
              if (done && (!o?.doneSince || done < o.doneSince)) continue
              const trail: Array<{ id: string; title: string }> = []
              for (let p = b.parentId ? list.find((x) => x.id === b.parentId) : undefined; p; p = p.parentId ? list.find((x) => x.id === p!.parentId) : undefined)
                trail.unshift({ id: p.id, title: p.markdown.split('\n')[0].slice(0, 60) })
              out.push({ canvasId: c.id, date, block: b, trail })
            }
          }
        }
        return out
      }
    },
    settings: {
      get: (key) => settings[key],
      onChange: (cb) => {
        settingsListeners.push(cb)
      }
    },
    secrets: {
      get: async (key) => h.secrets.get(key),
      set: async (key, value) => {
        h.secrets.set(key, value)
      },
      delete: async (key) => {
        h.secrets.delete(key)
      }
    },
    files: { repo: memoryFiles(h.files.repo, now), local: memoryFiles(h.files.local, now) },
    activity: {
      on: (cb) => {
        activityListeners.push(cb)
      }
    },
    ui: {
      notify: (message) => {
        h.notifications.push(String(message))
      },
      confirm: async (message) => {
        h.confirmations.push(String(message))
        return opts.confirm ?? true
      }
    },
    commands: {
      register: (cmdId, run) => {
        commandMap.set(cmdId, run)
      }
    },
    destinations: {
      register: (id, d) => {
        destinationMap.set(id, d)
      }
    },
    provide: {
      focus: (fn) => {
        focusProvider = fn
      }
    }
  }
  return h as TestHarness
}
