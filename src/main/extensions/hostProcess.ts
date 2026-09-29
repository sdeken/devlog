/**
 * The extension process. Started by the app as a Node child of the Devlog
 * binary (ELECTRON_RUN_AS_NODE) under Node's permission model with no file,
 * child-process, worker or addon allowances beyond reading this one file
 * (or, for an extension you said you trust, without the permission model).
 * It receives the extension's bundle over IPC, evaluates it, and turns the
 * `ctx` API into messages to the app, which does the real work.
 *
 * Built as its own entry (out/main/extensionHost.js) and must stay
 * self-contained: Node built-ins and type-only imports only.
 */
import { builtinModules } from 'node:module'
import vm from 'node:vm'
import type { ActivityNotice, BlockAddedEvent, CommandContext, Destination, DestinationSheet, DevlogContext, ExtensionFiles, ExtensionModule, FocusEvent, TimeEvent } from '@devlog/extension-api'
import type { CallMessage, FromExtension, InitMessage, ToExtension } from '@devlog/extension-api/protocol'

const send = (msg: FromExtension): void => {
  process.send?.(msg)
}

let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function call(method: string, ...args: unknown[]): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    send({ t: 'call', id, method, args })
  })
}

const commands = new Map<string, (context: CommandContext) => unknown>()
const activityListeners: Array<(n: ActivityNotice) => void> = []
const blockListeners: Array<(ev: BlockAddedEvent) => void> = []
const settingsListeners: Array<(s: Record<string, string>) => void> = []
const destinations = new Map<string, Destination>()
const viewHandlers = new Map<string, (method: string, args: unknown[]) => unknown>()
let focusProvider: ((from: string, to: string) => Promise<FocusEvent[]>) | null = null
let activityProvider: ((from: string, to: string) => Promise<TimeEvent[]>) | null = null
let settings: Record<string, string> = {}
let mod: Partial<ExtensionModule> = {}

function files(store: 'repo' | 'local'): ExtensionFiles {
  return {
    read: (p) => call('files.read', store, p) as Promise<Uint8Array | undefined>,
    readText: async (p) => {
      const b = (await call('files.read', store, p)) as Uint8Array | undefined
      return b === undefined ? undefined : Buffer.from(b).toString('utf8')
    },
    write: (p, data) => call('files.write', store, p, data) as Promise<void>,
    append: (p, text) => call('files.append', store, p, String(text)) as Promise<void>,
    list: (dir) => call('files.list', store, dir ?? '') as ReturnType<ExtensionFiles['list']>,
    stat: (p) => call('files.stat', store, p) as ReturnType<ExtensionFiles['stat']>,
    remove: (p) => call('files.remove', store, p) as Promise<void>
  }
}

function makeContext(init: InitMessage): DevlogContext {
  let subscribed = false
  let blocksSubscribed = false
  return {
    id: init.id,
    apiVersion: init.apiVersion,
    machine: init.machine,
    packageDir: init.packageDir,
    devlog: {
      canvases: () => call('devlog.canvases') as ReturnType<DevlogContext['devlog']['canvases']>,
      field: (canvasId, key) => call('devlog.field', canvasId, key) as Promise<string | null>,
      days: (canvasId) => call('devlog.days', canvasId) as Promise<string[]>,
      blocks: (canvasId, date) => call('devlog.blocks', canvasId, date) as ReturnType<DevlogContext['devlog']['blocks']>,
      search: (query) => call('devlog.search', query) as ReturnType<DevlogContext['devlog']['search']>,
      addBlock: (canvasId, markdown, opts) => call('devlog.addBlock', canvasId, markdown, opts ?? {}) as ReturnType<DevlogContext['devlog']['addBlock']>,
      todos: (opts) => call('devlog.todos', opts ?? {}) as ReturnType<DevlogContext['devlog']['todos']>,
      createCanvas: (input) => call('devlog.createCanvas', input) as ReturnType<DevlogContext['devlog']['createCanvas']>,
      updateCanvas: (canvasId, patch) => call('devlog.updateCanvas', canvasId, patch) as ReturnType<DevlogContext['devlog']['updateCanvas']>,
      editBlock: (canvasId, date, blockId, markdown) => call('devlog.editBlock', canvasId, date, blockId, markdown) as ReturnType<DevlogContext['devlog']['editBlock']>,
      promote: (canvasId, date, blockId, opts) => call('devlog.promote', canvasId, date, blockId, opts) as ReturnType<DevlogContext['devlog']['promote']>,
      activity: (from, to) => call('devlog.activity', from, to) as ReturnType<DevlogContext['devlog']['activity']>,
      range: (from, to) => call('devlog.range', from, to) as ReturnType<DevlogContext['devlog']['range']>,
      managedCanvas: (key, opts) => call('devlog.managedCanvas', key, opts ?? {}) as ReturnType<DevlogContext['devlog']['managedCanvas']>,
      onBlockAdded: (cb) => {
        if (typeof cb !== 'function') throw new Error('onBlockAdded(cb): cb must be a function')
        blockListeners.push(cb)
        if (!blocksSubscribed) {
          blocksSubscribed = true
          void call('devlog.subscribe')
        }
      }
    },
    settings: {
      get: (key) => settings[key],
      onChange: (cb) => {
        settingsListeners.push(cb)
      }
    },
    secrets: {
      get: (key) => call('secrets.get', key) as Promise<string | undefined>,
      set: (key, value) => call('secrets.set', key, value) as Promise<void>,
      delete: (key) => call('secrets.delete', key) as Promise<void>
    },
    files: { repo: files('repo'), local: files('local') },
    activity: {
      on: (cb) => {
        activityListeners.push(cb)
        if (!subscribed) {
          subscribed = true
          void call('activity.subscribe')
        }
      },
      idleAfter: (minutes) => {
        void call('activity.idleAfter', Number(minutes) || 0)
      }
    },
    ui: {
      notify: (message) => {
        void call('ui.notify', String(message))
      },
      confirm: (message) => call('ui.confirm', String(message)) as Promise<boolean>,
      pick: (items, opts) => call('ui.pick', items, opts ?? {}) as Promise<string | null>,
      open: (target) => {
        void call('ui.open', target)
      },
      openPage: (viewId) => {
        void call('ui.openPage', String(viewId))
      },
      highlight: (canvasId) => {
        void call('ui.highlight', canvasId ?? null)
      }
    },
    app: {
      setTrayLabel: (label) => {
        void call('app.trayLabel', label ?? null)
      },
      keepRunning: (on) => {
        void call('app.keepRunning', Boolean(on))
      }
    },
    commands: {
      register: (id, run) => {
        if (typeof run !== 'function') throw new Error('commands.register(id, run): run must be a function')
        commands.set(String(id), run)
        send({ t: 'registered', command: String(id) })
      }
    },
    destinations: {
      register: (id, destination) => {
        if (!destination || typeof destination.preview !== 'function' || typeof destination.send !== 'function') throw new Error('destinations.register(id, { preview, send })')
        destinations.set(String(id), destination)
        void call('destination.register', String(id))
      },
      list: () => call('destinations.list') as ReturnType<DevlogContext['destinations']['list']>,
      preview: (to, sheet) => call('destinations.preview', to, sheet) as ReturnType<DevlogContext['destinations']['preview']>,
      send: (to, sheet) => call('destinations.send', to, sheet) as ReturnType<DevlogContext['destinations']['send']>
    },
    views: {
      handle: (viewId, handler) => {
        if (typeof handler !== 'function') throw new Error('views.handle(viewId, handler): handler must be a function')
        viewHandlers.set(String(viewId), handler)
        void call('views.handle', String(viewId))
      },
      post: (viewId, message) => {
        void call('views.post', String(viewId), message)
      }
    },
    provide: {
      focus: (fn) => {
        if (typeof fn !== 'function') throw new Error('provide.focus(fn): fn must be a function')
        focusProvider = fn
        void call('provide.register', 'focus')
      },
      activity: (fn) => {
        if (typeof fn !== 'function') throw new Error('provide.activity(fn): fn must be a function')
        activityProvider = fn
        void call('provide.register', 'activity')
      }
    }
  }
}

/** Bundles may use Node built-ins (the permission model still applies to them); nothing else resolves. */
function safeRequire(name: string): unknown {
  const bare = name.replace(/^node:/, '')
  if (builtinModules.includes(bare)) return require(`node:${bare}`)
  throw new Error(`Extensions are bundled: cannot load "${name}"`)
}

async function start(init: InitMessage): Promise<void> {
  settings = init.settings
  const module = { exports: {} as Record<string, unknown> }
  const fn = vm.compileFunction(init.code, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: init.filename })
  fn(module.exports, safeRequire, module, init.filename, '')
  const exported = module.exports as Partial<ExtensionModule> & { default?: Partial<ExtensionModule> }
  mod = typeof exported.activate === 'function' ? exported : (exported.default ?? {})
  if (typeof mod.activate !== 'function') throw new Error('The extension does not export activate(ctx)')
  await mod.activate(makeContext(init))
  send({ t: 'ready', commands: [...commands.keys()] })
}

async function handleCall(msg: CallMessage): Promise<void> {
  try {
    let value: unknown
    if (msg.method === 'command.run') {
      const run = commands.get(String(msg.args[0]))
      if (!run) throw new Error(`No command "${String(msg.args[0])}"`)
      const context = (msg.args[1] ?? { source: 'switcher' }) as CommandContext
      value = await run(context)
    } else if (msg.method === 'activity.notice') {
      for (const cb of activityListeners) cb(msg.args[0] as ActivityNotice)
    } else if (msg.method === 'block.added') {
      for (const cb of blockListeners) cb(msg.args[0] as BlockAddedEvent)
    } else if (msg.method === 'destination.preview' || msg.method === 'destination.send') {
      const d = destinations.get(String(msg.args[0]))
      if (!d) throw new Error(`No destination "${String(msg.args[0])}"`)
      const sheet = msg.args[1] as DestinationSheet
      value = msg.method === 'destination.preview' ? await d.preview(sheet) : await d.send(sheet)
    } else if (msg.method === 'view.call') {
      const h = viewHandlers.get(String(msg.args[0]))
      if (!h) throw new Error(`The view "${String(msg.args[0])}" has no handler`)
      value = await h(String(msg.args[1]), Array.isArray(msg.args[2]) ? (msg.args[2] as unknown[]) : [])
    } else if (msg.method === 'provide.focus') {
      if (!focusProvider) throw new Error('No focus provider')
      value = await focusProvider(String(msg.args[0]), String(msg.args[1]))
    } else if (msg.method === 'provide.activity') {
      if (!activityProvider) throw new Error('No activity provider')
      value = await activityProvider(String(msg.args[0]), String(msg.args[1]))
    } else throw new Error(`Unknown method ${msg.method}`)
    send({ t: 'res', id: msg.id, ok: true, value: value ?? null })
  } catch (err) {
    send({ t: 'res', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

process.on('message', (raw: ToExtension) => {
  switch (raw.t) {
    case 'init':
      start(raw).catch((err: unknown) => {
        send({ t: 'failed', error: err instanceof Error ? (err.stack ?? err.message) : String(err) })
        setTimeout(() => process.exit(1), 50)
      })
      break
    case 'res': {
      const p = pending.get(raw.id)
      if (!p) break
      pending.delete(raw.id)
      if (raw.ok) p.resolve(raw.value ?? undefined)
      else p.reject(new Error(raw.error ?? 'Failed'))
      break
    }
    case 'call':
      void handleCall(raw)
      break
    case 'settings':
      settings = raw.settings
      for (const cb of settingsListeners) cb(settings)
      break
    case 'stop':
      Promise.resolve(mod.deactivate?.())
        .catch(() => undefined)
        .finally(() => process.exit(0))
      break
  }
})

process.on('disconnect', () => process.exit(0))
process.on('uncaughtException', (err) => {
  console.error(err)
})
process.on('unhandledRejection', (err) => {
  console.error(err)
})
