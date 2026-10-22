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
  // Fenced code gets a copy button, shown on hover (added after sanitizing: it is ours, not the note's).
  for (const pre of Array.from(doc.querySelectorAll('pre'))) {
    const wrap = doc.createElement('div')
    wrap.className = 'code-block'
    pre.replaceWith(wrap)
    wrap.append(pre)
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'code-copy'
    button.title = 'Copy the code'
    button.textContent = 'Copy'
    wrap.append(button)
  }
  return doc.body.innerHTML
}

/** The text a code block's copy button copies: the code as written, without the highlighting. */
export function codeBlockText(button: Element): string | null {
  const pre = button.closest('.code-block')?.querySelector('pre')
  return pre ? (pre.textContent ?? '') : null
}

/**
 * Make the copy buttons on rendered code blocks work, wherever the markdown
 * is shown. Caught on the way down, so the block or row around the button
 * never sees the click.
 */
export function installCodeCopy(): void {
  document.addEventListener('click', (ev) => {
    const button = (ev.target as Element | null)?.closest?.('.code-copy')
    const text = button ? codeBlockText(button) : null
    if (!button || text === null) return
    ev.preventDefault()
    ev.stopPropagation()
    void navigator.clipboard.writeText(text).then(
      () => flash(button, 'Copied'),
      () => flash(button, 'Could not copy')
    )
  }, true)
}

function flash(button: Element, label: string): void {
  button.textContent = label
  button.classList.add('is-done')
  setTimeout(() => {
    button.textContent = 'Copy'
    button.classList.remove('is-done')
  }, 1200)
}
