/**
 * `devlog://asset/<repo-relative path>` serves files from inside the currently
 * open devlog repository so the renderer can display pasted images without
 * `file://` access to the whole disk.
 */
import { net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { VIEW_SCHEME, viewKey } from './extensions/manager'
import { ASSET_HOST, ASSET_SCHEME } from '@shared/types'
import type { DevlogStore } from '@devlog/core/node'

export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    },
    {
      scheme: VIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: false, stream: true, bypassCSP: false }
    }
  ])
}

export function installAssetHandler(getStore: () => DevlogStore | null): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const store = getStore()
    if (!store) return new Response('No devlog open', { status: 503 })
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad URL', { status: 400 })
    }
    if (url.host !== ASSET_HOST) return new Response('Not found', { status: 404 })
    let abs: string
    try {
      abs = store.resolveAsset(decodeURIComponent(url.pathname.replace(/^\/+/, '')))
    } catch {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const res = await net.fetch(pathToFileURL(abs).toString())
      const headers = new Headers(res.headers)
      headers.set('Cache-Control', 'no-cache')
      return new Response(res.body, { status: res.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/**
 * A view's page must not reach anything but its own files: no network, no
 * other origin, no plugins. It talks to its extension only through the app
 * (postMessage to the parent, which the sandboxed frame cannot otherwise touch).
 */
const VIEW_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"

const VIEW_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2'
}

/** `devlog-ext://<key as hex>/<file>`: a running extension's view files, from its own folder only. */
export function installViewHandler(viewRoot: (key: string) => string | null): void {
  protocol.handle(VIEW_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad URL', { status: 400 })
    }
    const key = viewKey(url.host)
    const root = key ? viewRoot(key) : null
    if (!root) return new Response('Not found', { status: 404 })
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const abs = path.resolve(root, rel)
    if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '') || !abs.startsWith(path.resolve(root) + path.sep)) return new Response('Forbidden', { status: 403 })
    const type = VIEW_TYPES[path.extname(abs).toLowerCase()]
    if (!type) return new Response('Not found', { status: 404 })
    try {
      const res = await net.fetch(pathToFileURL(abs).toString())
      if (!res.ok) return new Response('Not found', { status: 404 })
      return new Response(res.body, {
        status: 200,
        headers: { 'Content-Type': type, 'Content-Security-Policy': VIEW_CSP, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
