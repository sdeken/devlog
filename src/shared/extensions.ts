/** What the renderer knows about the extensions of the open devlog. */
import type { ExtensionCommand, ExtensionDestination, ExtensionField, ExtensionPermissions, ExtensionView, Grant } from '@devlog/core'

export type ExtensionState =
  /** Being downloaded or unpacked. */
  | 'installing'
  /** Could not be installed or started (see `error`). */
  | 'error'
  /** Installed; waits for you to allow it (first time, or its code changed). */
  | 'needs-consent'
  | 'starting'
  | 'running'
  /** Allowed before, but stopped (it crashed, or failed to start). */
  | 'failed'

export interface ExtensionInfo {
  /** The `devlog.json` key (owner/repo, or a name). */
  key: string
  spec: string
  id: string
  source: 'github' | 'url' | 'builtin' | 'dev'
  displayName: string
  description?: string
  version: string | null
  sha256: string | null
  state: ExtensionState
  error: string | null
  permissions: ExtensionPermissions
  /** What you allowed (null until allowed). */
  grant: Grant | null
  /** It was allowed before, but this is a different build. */
  changedSinceConsent: boolean
  canvasFields: ExtensionField[]
  settings: ExtensionField[]
  settingValues: Record<string, string>
  secrets: Array<ExtensionField & { set: boolean }>
  commands: Array<ExtensionCommand & { ready: boolean }>
  /** Places finished timesheets can be sent; `ready` once it is running and has registered it. */
  destinations: Array<ExtensionDestination & { ready: boolean }>
  /** Its views, with where they load from (1.5); only while it runs. */
  views: Array<ExtensionView & { url: string }>
  /** The command that tests its settings, if it has one. */
  check?: string
  /** Required settings and secrets that are not set yet (their labels). */
  missing: string[]
}

export interface ExtensionUpdateReport {
  updated: Array<{ key: string; from: string | null; to: string }>
  unchanged: string[]
  errors: Array<{ key: string; error: string }>
}
