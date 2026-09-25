import { isExternalSrc } from '@devlog/core'
import { ASSET_HOST, ASSET_SCHEME } from '@shared/types'

const PREFIX = `${ASSET_SCHEME}://${ASSET_HOST}/`

/** Map a repo-root-relative image path to a URL the renderer can load. */
export function toAssetUrl(src: string | null | undefined): string {
  if (!src) return ''
  if (isExternalSrc(src)) return src
  return PREFIX + src.split('/').map(encodeURIComponent).join('/')
}

/** Inverse of `toAssetUrl`. */
export function fromAssetUrl(url: string | null | undefined): string {
  if (!url) return ''
  if (url.startsWith(PREFIX)) return url.slice(PREFIX.length).split('/').map(decodeURIComponent).join('/')
  return url
}
