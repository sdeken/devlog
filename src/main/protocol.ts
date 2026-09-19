/**
 * `devlog://asset/<repo-relative path>` serves files from inside the currently
 * open devlog repository so the renderer can display pasted images without
 * `file://` access to the whole disk.
 */
import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { ASSET_HOST, ASSET_SCHEME } from '@shared/types'
import type { DevlogStore } from './devlog/store'

export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
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
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!rel || rel.includes('\0') || rel.split('/').includes('.git')) {
      return new Response('Not found', { status: 404 })
    }
    let abs: string
    try {
      abs = store.resolve(rel)
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
