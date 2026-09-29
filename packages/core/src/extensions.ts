/**
 * Extensions: the pure parts (no I/O). See docs/EXTENSIONS.md.
 *
 *  - the extension manifest (`devlog-extension.json`) and its validation;
 *  - where an extension comes from (the entries of `devlog.json`'s
 *    `extensions`), the id derived from that, and version ranges;
 *  - read/write grants and what they let an extension see.
 */
import { descendantCanvasIds, JOURNAL_ID } from './format/canvases'
import type { CanvasMeta } from './types'

/** The extension API this build of Devlog provides. Manifests declare the range they were built for. */
export const EXTENSION_API_VERSION = '1.4.0'
export const EXTENSION_MANIFEST_FILE = 'devlog-extension.json'
export const EXTENSIONS_DIR = 'extensions'
export const LOCK_FILE = 'devlog.lock.json'

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export type ExtensionFieldType = 'text' | 'url' | 'email' | 'number' | 'select' | 'checkbox' | 'textarea'
export const FIELD_TYPES: ExtensionFieldType[] = ['text', 'url', 'email', 'number', 'select', 'checkbox', 'textarea']

export interface ExtensionField {
  key: string
  label: string
  placeholder?: string
  /** A sentence or two under the field. */
  description?: string
  /** How to edit it (settings and canvas fields; secrets are always hidden text). Default text. */
  type?: ExtensionFieldType
  /** For `select`. */
  options?: Array<{ value: string; label: string }>
  /** The extension cannot work without it; the app says so until it is set. */
  required?: boolean
}

/**
 * Whether a value is acceptable for a field (empty is fine unless required).
 * Returns the problem, or null.
 */
export function fieldProblem(field: ExtensionField, value: string | undefined): string | null {
  const v = (value ?? '').trim()
  if (!v) return field.required ? `${field.label} is required` : null
  switch (field.type) {
    case 'url':
      return /^https?:\/\/[^\s/]+/i.test(v) ? null : `${field.label}: enter a web address starting with https://`
    case 'email':
      return /^[^\s@]+@[^\s@]+$/.test(v) ? null : `${field.label}: enter an email address`
    case 'number':
      return Number.isFinite(Number(v)) ? null : `${field.label}: enter a number`
    case 'select':
      return field.options?.some((o) => o.value === v) ? null : `${field.label}: pick one of the options`
    case 'checkbox':
      return v === 'true' || v === 'false' ? null : `${field.label}: true or false`
    default:
      return null
  }
}

export interface ExtensionCommand {
  id: string
  label: string
}

/** Somewhere a finished timesheet can be sent (Jira worklogs, a CSV file, …). */
export interface ExtensionDestination {
  id: string
  label: string
}

export interface ExtensionPermissions {
  /** Wants to read blocks; you choose the scope. */
  read?: boolean
  /** Wants to add blocks; you choose the scope. */
  write?: boolean
  /** Domains it talks to: shown at consent, not enforced in v1. */
  network?: string[]
  /**
   * Runs without the sandbox: it can read and change your files, start
   * programs and see everything you can. It runs only if you say you trust it.
   */
  unrestricted?: boolean
}

export interface ExtensionManifest {
  name: string
  displayName: string
  version: string
  description?: string
  /** Range of the extension API it was built for. */
  api: string
  /** Bundled main file, relative to the extension folder. */
  main?: string
  contributes: {
    canvasFields: ExtensionField[]
    settings: ExtensionField[]
    secrets: ExtensionField[]
    commands: ExtensionCommand[]
    destinations: ExtensionDestination[]
    /** A command that tests the settings (its return value is shown); offered on the settings page. */
    check?: string
  }
  permissions: ExtensionPermissions
  /** Globs (within its repo folder) that git should union-merge. */
  appendOnly: string[]
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/
const GLOB_RE = /^[A-Za-z0-9_.*/{}-]{1,128}$/

/** Validate a parsed `devlog-extension.json`. Throws with every problem found. */
export function parseExtensionManifest(raw: unknown): ExtensionManifest {
  const errors: string[] = []
  const o = (raw ?? {}) as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('The manifest is not a JSON object')
  const str = (k: string, required: boolean): string => {
    const v = o[k]
    if (v === undefined && !required) return ''
    if (typeof v !== 'string' || !v.trim()) {
      errors.push(`"${k}" must be a non-empty string`)
      return ''
    }
    return v.trim()
  }
  const name = str('name', true)
  if (name && !NAME_RE.test(name)) errors.push('"name" must be lowercase letters, digits, ".", "_" or "-"')
  const version = str('version', true)
  if (version && !parseVersion(version)) errors.push(`"version" is not a version: ${version}`)
  const api = str('api', true)
  if (api && !parseRange(api)) errors.push(`"api" is not a version range: ${api}`)
  const main = str('main', false)
  if (main && !isSafeRelativePath(main)) errors.push('"main" must be a relative path inside the extension')

  const c = (o.contributes ?? {}) as Record<string, unknown>
  const fields = (k: string): ExtensionField[] => {
    const list = c[k] ?? []
    if (!Array.isArray(list)) {
      errors.push(`"contributes.${k}" must be a list`)
      return []
    }
    const out: ExtensionField[] = []
    for (const f of list as Array<Record<string, unknown>>) {
      if (typeof f?.key !== 'string' || !KEY_RE.test(f.key)) {
        errors.push(`"contributes.${k}": key ${JSON.stringify(f?.key)} must be lowercase letters, digits, "_" or "-"`)
        continue
      }
      if (out.some((x) => x.key === f.key)) {
        errors.push(`"contributes.${k}": duplicate key ${f.key}`)
        continue
      }
      const type = f.type === undefined ? undefined : FIELD_TYPES.includes(f.type as ExtensionFieldType) ? (f.type as ExtensionFieldType) : null
      if (type === null) {
        errors.push(`"contributes.${k}": ${f.key} has an unknown type ${JSON.stringify(f.type)}`)
        continue
      }
      const options = Array.isArray(f.options)
        ? (f.options as Array<Record<string, unknown>>).filter((o) => typeof o?.value === 'string').map((o) => ({ value: String(o.value), label: typeof o.label === 'string' ? o.label : String(o.value) }))
        : undefined
      if (type === 'select' && !options?.length) {
        errors.push(`"contributes.${k}": ${f.key} is a select with no options`)
        continue
      }
      out.push({
        key: f.key,
        label: typeof f.label === 'string' && f.label.trim() ? f.label.trim() : f.key,
        ...(typeof f.placeholder === 'string' ? { placeholder: f.placeholder } : {}),
        ...(typeof f.description === 'string' && f.description.trim() ? { description: f.description.trim() } : {}),
        ...(type && type !== 'text' ? { type } : {}),
        ...(options?.length ? { options } : {}),
        ...(f.required === true ? { required: true } : {})
      })
    }
    return out
  }
  const commands: ExtensionCommand[] = []
  for (const cmd of (Array.isArray(c.commands) ? c.commands : []) as Array<Record<string, unknown>>) {
    if (typeof cmd?.id !== 'string' || !KEY_RE.test(cmd.id)) errors.push(`"contributes.commands": id ${JSON.stringify(cmd?.id)} is not valid`)
    else commands.push({ id: cmd.id, label: typeof cmd.label === 'string' && cmd.label.trim() ? cmd.label.trim() : cmd.id })
  }

  const p = (o.permissions ?? {}) as Record<string, unknown>
  const permissions: ExtensionPermissions = {}
  if (p.read === true) permissions.read = true
  if (p.write === true) permissions.write = true
  if (p.unrestricted === true) permissions.unrestricted = true
  if (p.network !== undefined) {
    if (!Array.isArray(p.network) || p.network.some((d) => typeof d !== 'string' || !/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(d))) errors.push('"permissions.network" must be a list of domains')
    else permissions.network = (p.network as string[]).map((d) => d.toLowerCase())
  }

  const appendOnly: string[] = []
  for (const g of (Array.isArray(o.appendOnly) ? o.appendOnly : []) as unknown[]) {
    if (typeof g !== 'string' || !GLOB_RE.test(g) || g.includes('..') || g.startsWith('/')) errors.push(`"appendOnly": ${JSON.stringify(g)} is not a relative glob`)
    else appendOnly.push(g)
  }

  const destinations: ExtensionDestination[] = []
  for (const d of (Array.isArray(c.destinations) ? c.destinations : []) as Array<Record<string, unknown>>) {
    if (typeof d?.id !== 'string' || !KEY_RE.test(d.id)) errors.push(`"contributes.destinations": id ${JSON.stringify(d?.id)} is not valid`)
    else destinations.push({ id: d.id, label: typeof d.label === 'string' && d.label.trim() ? d.label.trim() : d.id })
  }
  let check: string | undefined
  if (c.check !== undefined) {
    if (typeof c.check !== 'string' || !commands.some((x) => x.id === c.check)) errors.push('"contributes.check" must name one of its commands')
    else check = c.check
  }
  const contributes = { canvasFields: fields('canvasFields'), settings: fields('settings'), secrets: fields('secrets'), commands, destinations, ...(check ? { check } : {}) }
  if (errors.length) throw new Error(`Invalid extension manifest: ${errors.join('; ')}`)
  const displayName = typeof o.displayName === 'string' && o.displayName.trim() ? o.displayName.trim() : name
  return {
    name,
    displayName,
    version,
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    api,
    ...(main ? { main } : {}),
    contributes,
    permissions,
    appendOnly
  }
}

/** True for `a/b.js`-style paths: relative, no `..`, no backslashes or drive letters. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 512 || p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

// ---------------------------------------------------------------------------
// Sources and ids
// ---------------------------------------------------------------------------

export type ExtensionSource =
  | { kind: 'github'; owner: string; repo: string; range: string }
  | { kind: 'url'; name: string; url: string }
  | { kind: 'builtin'; name: string }

const GH_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/**
 * Read one `devlog.json` `extensions` entry:
 *  - `"owner/repo": "^1.2.0"` a GitHub repository's releases, newest matching tag;
 *  - `"name": "https://…/x.zip"` one file;
 *  - `"name": "builtin"` an extension that ships with the app.
 */
export function parseExtensionEntry(key: string, value: unknown): ExtensionSource {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Extension ${key}: expected a version, a URL or "builtin"`)
  const v = value.trim()
  const slash = key.split('/')
  if (slash.length === 2) {
    if (!GH_PART.test(slash[0]) || !GH_PART.test(slash[1])) throw new Error(`Extension ${key}: not an owner/repository name`)
    if (!parseRange(v)) throw new Error(`Extension ${key}: "${v}" is not a version range`)
    return { kind: 'github', owner: slash[0], repo: slash[1], range: v }
  }
  if (!NAME_RE.test(key)) throw new Error(`Extension ${key}: names are lowercase letters, digits, ".", "_" or "-"`)
  if (v === 'builtin') return { kind: 'builtin', name: key }
  if (/^https:\/\//i.test(v)) {
    try {
      new URL(v)
    } catch {
      throw new Error(`Extension ${key}: not a URL`)
    }
    return { kind: 'url', name: key, url: v }
  }
  throw new Error(`Extension ${key}: expected owner/repo with a version, a https:// URL or "builtin"`)
}

/**
 * The id an extension's folders, settings, secrets and grants are keyed by.
 * It comes from where the extension is fetched, never from its manifest, so
 * one extension cannot take another's name.
 */
export function extensionId(source: ExtensionSource): string {
  if (source.kind === 'github') return `${source.owner}.${source.repo}`.toLowerCase()
  if (source.kind === 'builtin') return `builtin.${source.name}`
  return `url.${source.name}`
}

// ---------------------------------------------------------------------------
// Versions and ranges (a small subset of semver)
// ---------------------------------------------------------------------------

export interface Version {
  major: number
  minor: number
  patch: number
  pre: string
}

export function parseVersion(s: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(s.trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' }
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch || (a.pre === b.pre ? 0 : a.pre === '' ? 1 : b.pre === '' ? -1 : a.pre < b.pre ? -1 : 1)
}

type Range = (v: Version) => boolean

/**
 * Supported: `1.2.3` (exact), `^1.2.3`, `~1.2.3`, `1.2.x`, `1.x`, `*`,
 * `latest`. Pre-releases only match an exact range.
 */
export function parseRange(s: string): Range | null {
  const r = s.trim()
  if (r === '*' || r === 'latest' || r === 'x') return (v) => !v.pre
  const exact = parseVersion(r)
  if (exact) return (v) => compareVersions(v, exact) === 0
  const caret = /^\^(.+)$/.exec(r)
  if (caret) {
    const b = parseVersion(caret[1])
    if (!b) return null
    return (v) => {
      if (v.pre || compareVersions(v, b) < 0) return false
      if (b.major > 0) return v.major === b.major
      if (b.minor > 0) return v.major === 0 && v.minor === b.minor
      return v.major === 0 && v.minor === 0 && v.patch === b.patch
    }
  }
  const tilde = /^~(.+)$/.exec(r)
  if (tilde) {
    const b = parseVersion(tilde[1])
    if (!b) return null
    return (v) => !v.pre && compareVersions(v, b) >= 0 && v.major === b.major && v.minor === b.minor
  }
  const xr = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(x|\*))?$/.exec(r)
  if (xr) {
    const major = Number(xr[1])
    const minor = xr[2] === undefined || xr[2] === 'x' || xr[2] === '*' ? null : Number(xr[2])
    return (v) => !v.pre && v.major === major && (minor === null || v.minor === minor)
  }
  return null
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version)
  const r = parseRange(range)
  return Boolean(v && r && r(v))
}

/** The newest of `versions` (tags such as `v1.2.3`) matching `range`, or null. */
export function newestMatching(versions: string[], range: string): string | null {
  const r = parseRange(range)
  if (!r) return null
  let best: { tag: string; v: Version } | null = null
  for (const tag of versions) {
    const v = parseVersion(tag)
    if (v && r(v) && (!best || compareVersions(v, best.v) > 0)) best = { tag, v }
  }
  return best?.tag ?? null
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** The whole devlog, or chosen canvases with everything beneath them. */
export type GrantScope = { all: true } | { canvases: string[] }

export interface Grant {
  read: GrantScope | null
  write: GrantScope | null
  /** You said you trust it to run unrestricted (only for extensions that ask). */
  trusted?: boolean
}

export const NO_GRANT: Grant = { read: null, write: null }

/** Canvas ids a scope covers (a chosen canvas brings everything beneath it; the journal only itself). */
export function scopeCanvasIds(canvases: CanvasMeta[], scope: GrantScope | null): Set<string> {
  if (!scope) return new Set()
  if ('all' in scope) return new Set([JOURNAL_ID, ...canvases.map((c) => c.id)])
  const known = new Set(canvases.map((c) => c.id))
  const out = new Set<string>()
  for (const id of scope.canvases) {
    if (id === JOURNAL_ID) {
      out.add(JOURNAL_ID)
      continue
    }
    if (!known.has(id)) continue
    out.add(id)
    for (const d of descendantCanvasIds(canvases, id)) out.add(d)
  }
  return out
}

/**
 * What an extension may list: every canvas it can read or write, plus their
 * ancestors (so it can name them), and nothing else.
 */
export function visibleCanvases(canvases: CanvasMeta[], grant: Grant): CanvasMeta[] {
  const covered = new Set([...scopeCanvasIds(canvases, grant.read), ...scopeCanvasIds(canvases, grant.write)])
  const byId = new Map(canvases.map((c) => [c.id, c]))
  const show = new Set<string>()
  for (const id of covered) {
    let cur = byId.get(id)
    show.add(id)
    while (cur?.parentId && !show.has(cur.parentId)) {
      show.add(cur.parentId)
      cur = byId.get(cur.parentId)
    }
  }
  return canvases.filter((c) => show.has(c.id))
}

/** Describe a scope for people: "the whole devlog", "Acme, Globex". */
export function describeScope(canvases: CanvasMeta[], scope: GrantScope | null): string {
  if (!scope) return 'nothing'
  if ('all' in scope) return 'the whole devlog'
  const names = scope.canvases.map((id) => canvases.find((c) => c.id === id)?.title ?? (id === JOURNAL_ID ? 'Journal' : null)).filter(Boolean)
  return names.length ? names.join(', ') : 'nothing'
}

/** Keep a stored grant well-formed (it comes from a JSON file). */
export function sanitizeGrant(raw: unknown): Grant {
  const scope = (s: unknown): GrantScope | null => {
    if (!s || typeof s !== 'object') return null
    const o = s as Record<string, unknown>
    if (o.all === true) return { all: true }
    if (Array.isArray(o.canvases)) return { canvases: o.canvases.filter((x): x is string => typeof x === 'string').slice(0, 500) }
    return null
  }
  const o = (raw ?? {}) as Record<string, unknown>
  return { read: scope(o.read), write: scope(o.write), ...(o.trusted === true ? { trusted: true } : {}) }
}
