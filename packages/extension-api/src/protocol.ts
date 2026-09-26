/**
 * The wire protocol between the Devlog app and an extension's process.
 * Messages go over Node's IPC channel with structured-clone serialisation.
 *
 * App → extension: `init` once, then `call` (run a command, deliver a
 * notice), `res` (answers to the extension's calls), `settings`, `stop`.
 * Extension → app: `ready`, `call` (API requests), `res`, `failed`.
 */
import type { ActivityNotice } from './index'

export interface InitMessage {
  t: 'init'
  id: string
  apiVersion: string
  machine: string
  /** Only for unrestricted (trusted) extensions. */
  packageDir: string | null
  /** The bundle's source; evaluated in the extension process (which cannot read files). */
  code: string
  filename: string
  settings: Record<string, string>
}

export interface CallMessage {
  t: 'call'
  id: number
  method: string
  args: unknown[]
}

export interface ResultMessage {
  t: 'res'
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

export type ToExtension = InitMessage | CallMessage | ResultMessage | { t: 'settings'; settings: Record<string, string> } | { t: 'stop' }

export type FromExtension =
  | { t: 'ready'; commands: string[] }
  | { t: 'failed'; error: string }
  | CallMessage
  | ResultMessage
  | { t: 'registered'; command: string }

/** Methods the app calls on the extension. */
export type ExtensionSideMethod = 'command.run' | 'activity.notice' | 'provide.focus'

export type { ActivityNotice }

/** Methods the extension calls on the app (all return promises). */
export const APP_METHODS = [
  'devlog.canvases',
  'devlog.field',
  'devlog.days',
  'devlog.blocks',
  'devlog.search',
  'devlog.addBlock',
  'secrets.get',
  'secrets.set',
  'secrets.delete',
  'files.read',
  'files.write',
  'files.append',
  'files.list',
  'files.stat',
  'files.remove',
  'activity.subscribe',
  'ui.notify',
  'ui.confirm',
  'provide.register'
] as const

export type AppMethod = (typeof APP_METHODS)[number]
