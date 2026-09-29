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
import { API_VERSION, type ActivityNotice, type BlockAddedEvent, type CommandContext, type DevlogContext, type PickItem, type TimeEvent, type ExtensionBlock, type ExtensionCanvas, type ExtensionFileInfo, type ExtensionFiles, type Destination, type DestinationLine, type DestinationSheet, type FocusEvent, type SendResult } from './index'

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
  /** Run a registered command (with a context, as the app would give it; 1.6). */
  run(commandId: string, context?: Partial<CommandContext>): Promise<unknown>
  /** Tell onBlockAdded listeners that someone posted a block (1.6); it is added to the canvas's day. */
  post(canvasId: string, date: string, block: ExtensionBlock): void
  /** Ask the registered activity provider (1.6). */
  timeEvents(fromDate: string, toDate: string): Promise<TimeEvent[]>
  /** Canvases made with devlog.createCanvas (they join `canvases`). (1.6) */
  created: string[]
  /** Quick picks shown, and how to answer them (default: the first item). (1.6) */
  picks: Array<{ items: PickItem[]; placeholder?: string }>
  answerPick: (items: PickItem[]) => string | null
  /** ui.open targets, in order. (1.6) */
  opened: Array<{ canvasId: string; date?: string; blockId?: string }>
  /** What the extension asked of the app (1.6). */
  app: { trayLabel: string | null; keepRunning: boolean; idleMinutes: number; highlight: string | null }
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
  /** Call a view's handler, as its page would (1.5). */
  viewCall(viewId: string, method: string, ...args: unknown[]): Promise<unknown>
  /** Messages sent with views.post, per view. */
  viewMessages: Map<string, unknown[]>
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
  const blockListeners: Array<(ev: BlockAddedEvent) => void> = []
  const commandMap = new Map<string, (context: CommandContext) => unknown>()
  let focusProvider: ((from: string, to: string) => Promise<FocusEvent[]>) | null = null
  let activityProvider: ((from: string, to: string) => Promise<TimeEvent[]>) | null = null
  const destinationMap = new Map<string, Destination>()
  const viewHandlers = new Map<string, (method: string, args: unknown[]) => unknown>()
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
    run: async (commandId, context) => {
      const fn = commandMap.get(commandId)
      if (!fn) throw new Error(`No command "${commandId}"`)
      return fn({ source: 'switcher', ...(context ?? {}) })
    },
    post: (canvasId, date, block) => {
      const c = canvases.find((x) => x.id === canvasId)
      if (c) (c.days ??= {})[date] = [...(c.days[date] ?? []), block]
      if (!within(opts.read, canvasId)) return
      for (const cb of blockListeners) cb({ canvasId, date, block })
    },
    timeEvents: async (from, to) => {
      if (!activityProvider) throw new Error('No activity provider registered')
      return activityProvider(from, to)
    },
    created: [],
    picks: [],
    answerPick: (items) => items[0]?.id ?? null,
    opened: [],
    app: { trayLabel: null, keepRunning: false, idleMinutes: 0, highlight: null },
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
    },
    viewCall: async (viewId, method, ...args) => {
      const handler = viewHandlers.get(viewId)
      if (!handler) throw new Error(`The view "${viewId}" has no handler`)
      return handler(method, args)
    },
    viewMessages: new Map()
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
  const ownType = (t: unknown): string => {
    const name = String(t ?? '')
    if (!name) throw new Error('A node type is needed')
    return name.includes('/') ? name : `${id}/${name}`
  }
  const toCanvas = ({ days: _d, ...c }: TestCanvas): ExtensionCanvas => ({ ...c, fields: { ...c.fields } })
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
      },
      createCanvas: async (input) => {
        const parentId = input.parentId ?? null
        if (parentId ? !within(opts.write, parentId) : opts.write !== undefined && opts.write !== 'all') throw new Error('No write access there')
        const type = input.type ? ownType(input.type) : undefined
        const c: TestCanvas = { id: `c${canvases.length + 1}`, title: input.title.trim(), parentId, task: type?.endsWith('/task') ?? false, ...(type ? { type } : {}), archived: false, fields: {} }
        canvases.push(c)
        h.created.push(c.id)
        return toCanvas(c)
      },
      updateCanvas: async (canvasId, patch) => {
        if (!within(opts.write, canvasId)) throw new Error('No write access to that canvas')
        const c = canvas(canvasId)
        if (patch.title !== undefined) c.title = patch.title
        if (patch.parentId !== undefined) c.parentId = patch.parentId
        if (patch.type !== undefined) {
          if (patch.type === null) delete c.type
          else c.type = ownType(patch.type)
          c.task = c.type?.endsWith('/task') ?? false
        }
        if (patch.archived !== undefined) c.archived = patch.archived
        return toCanvas(c)
      },
      editBlock: async (canvasId, date, blockId, markdown) => {
        if (!within(opts.write, canvasId)) throw new Error('No write access to that canvas')
        const b = canvas(canvasId).days?.[date]?.find((x) => x.id === blockId)
        if (!b) throw new Error(`Entry ${blockId} not found on ${date}`)
        if (b.meta?.ext !== id) throw new Error('Only blocks it added')
        b.markdown = markdown.trim()
        b.updatedAt = now().toISOString()
        return { ...b }
      },
      promote: async (canvasId, date, blockId, o) => {
        if (!within(opts.write, canvasId)) throw new Error('No write access to that canvas')
        const list = canvas(canvasId).days?.[date] ?? []
        const b = list.find((x) => x.id === blockId)
        if (!b) throw new Error(`Entry ${blockId} not found on ${date}`)
        if (b.kind === 'task' && b.meta?.canvas) return { canvas: toCanvas(canvas(b.meta.canvas)), block: { ...b } }
        const type = ownType(o.type)
        const c: TestCanvas = { id: `c${canvases.length + 1}`, title: b.markdown.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80), parentId: canvasId, task: type.endsWith('/task'), type, archived: false, fields: {} }
        canvases.push(c)
        h.created.push(c.id)
        b.kind = 'task'
        b.meta = { ...(b.meta ?? {}), canvas: c.id }
        return { canvas: toCanvas(c), block: { ...b } }
      },
      onBlockAdded: (cb) => {
        blockListeners.push(cb)
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
      },
      idleAfter: (minutes) => {
        h.app.idleMinutes = Math.max(0, Number(minutes) || 0)
      }
    },
    ui: {
      notify: (message) => {
        h.notifications.push(String(message))
      },
      confirm: async (message) => {
        h.confirmations.push(String(message))
        return opts.confirm ?? true
      },
      pick: async (items, o) => {
        h.picks.push({ items, ...(o?.placeholder ? { placeholder: o.placeholder } : {}) })
        return h.answerPick(items)
      },
      open: (target) => {
        h.opened.push({ ...target })
      },
      highlight: (canvasId) => {
        h.app.highlight = canvasId
      }
    },
    app: {
      setTrayLabel: (label) => {
        h.app.trayLabel = label
      },
      keepRunning: (on) => {
        h.app.keepRunning = on
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
    views: {
      handle: (viewId, handler) => {
        viewHandlers.set(viewId, handler)
      },
      post: (viewId, message) => {
        h.viewMessages!.set(viewId, [...(h.viewMessages!.get(viewId) ?? []), message])
      }
    },
    provide: {
      focus: (fn) => {
        focusProvider = fn
      },
      activity: (fn) => {
        activityProvider = fn
      }
    }
  }
  return h as TestHarness
}
