import { marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { toAssetUrl } from '@renderer/assets'

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      const language = (lang ?? '').trim().split(/\s+/)[0].toLowerCase()
      if (language && hljs.getLanguage(language)) {
        const html = hljs.highlight(text, { language, ignoreIllegals: true }).value
        return `<pre><code class="hljs language-${escapeHtml(language)}">${html}</code></pre>\n`
      }
      return `<pre><code class="hljs">${escapeHtml(text)}</code></pre>\n`
    }
  }
})

/** Render entry markdown to sanitized HTML with image sources resolved through the asset scheme. */
export function renderMarkdown(markdown: string): string {
  const raw = marked.parse(markdown, { async: false }) as string
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|devlog|data):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i
  })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    img.setAttribute('src', toAssetUrl(src))
    img.setAttribute('loading', 'lazy')
    img.setAttribute('data-lightbox', '1')
  }
  for (const a of Array.from(doc.querySelectorAll('a'))) {
    a.setAttribute('rel', 'noopener')
  }
  return doc.body.innerHTML
}
