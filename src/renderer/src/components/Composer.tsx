import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from '@tiptap/markdown'
import type { EditorView } from '@tiptap/pm/view'
import { isBlankMarkdown, localDate } from '@shared/entries'
import { api } from '@renderer/api'
import { DevlogImage, SubmitKeymap } from '@renderer/editor/extensions'

export interface ComposerProps {
  mode: 'new' | 'edit'
  initialMarkdown?: string
  placeholder?: string
  autoFocus?: boolean
  /** Day whose asset folder receives pasted images. Defaults to today. */
  assetDate?: string
  /** Called with markdown when the user posts. Resolve to clear the editor. */
  onSubmit: (markdown: string) => Promise<void>
  onCancel?: () => void
  /** Persist draft under this key in localStorage (new mode). */
  draftKey?: string
  focusToken?: number
}

interface ToolButton {
  label: string
  title: string
  isActive?: (e: Editor) => boolean
  run: (e: Editor) => void
  className?: string
}

const TOOLS: ToolButton[] = [
  { label: 'B', title: 'Bold (⌘B)', className: 'tb-bold', isActive: (e) => e.isActive('bold'), run: (e) => e.chain().focus().toggleBold().run() },
  { label: 'I', title: 'Italic (⌘I)', className: 'tb-italic', isActive: (e) => e.isActive('italic'), run: (e) => e.chain().focus().toggleItalic().run() },
  { label: 'S', title: 'Strikethrough (⌘⇧X)', className: 'tb-strike', isActive: (e) => e.isActive('strike'), run: (e) => e.chain().focus().toggleStrike().run() },
  { label: '<>', title: 'Inline code (⌘E)', className: 'tb-code', isActive: (e) => e.isActive('code'), run: (e) => e.chain().focus().toggleCode().run() },
  { label: '•', title: 'Bulleted list (⌘⇧8)', isActive: (e) => e.isActive('bulletList'), run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: '1.', title: 'Numbered list (⌘⇧7)', isActive: (e) => e.isActive('orderedList'), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: '❝', title: 'Quote (⌘⇧B)', isActive: (e) => e.isActive('blockquote'), run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: '{ }', title: 'Code block (⌘⌥C)', isActive: (e) => e.isActive('codeBlock'), run: (e) => e.chain().focus().toggleCodeBlock().run() },
  { label: 'H', title: 'Heading (⌘⌥2)', isActive: (e) => e.isActive('heading'), run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() }
]

function isImageFile(f: File): boolean {
  return f.type.startsWith('image/')
}

function clearDraft(draftKey?: string): void {
  if (!draftKey) return
  try {
    localStorage.removeItem(draftKey)
  } catch {
    /* ignore */
  }
}

/** True when the editor holds text or at least one image. */
function hasContent(editor: Editor): boolean {
  if (!isBlankMarkdown(editor.getText())) return true
  let found = false
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') found = true
    return !found
  })
  return found
}

export function Composer({
  mode,
  initialMarkdown = '',
  placeholder = 'Write a devlog entry… (Enter to post, Shift+Enter for a new line)',
  autoFocus = false,
  assetDate,
  onSubmit,
  onCancel,
  draftKey,
  focusToken
}: ComposerProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [uploading, setUploading] = useState(0)
  const [, forceRender] = useState(0)
  const submitRef = useRef<() => boolean>(() => false)
  const cancelRef = useRef<() => boolean>(() => false)
  const fileInput = useRef<HTMLInputElement>(null)
  const editorRef = useRef<Editor | null>(null)

  const startContent = useMemo(() => {
    if (initialMarkdown) return initialMarkdown
    if (draftKey) {
      try {
        return localStorage.getItem(draftKey) ?? ''
      } catch {
        return ''
      }
    }
    return ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const uploadImages = useCallback(
    async (files: File[], view?: EditorView, coords?: { left: number; top: number }) => {
      const editor = editorRef.current
      if (!editor || files.length === 0) return
      setUploading((n) => n + files.length)
      setError(null)
      try {
        const date = assetDate ?? localDate(new Date())
        let insertPos: number | null = null
        if (view && coords) insertPos = view.posAtCoords(coords)?.pos ?? null
        for (const file of files) {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const saved = await api.assets.save(date, bytes, file.type, file.name)
          const node = { type: 'image', attrs: { src: saved.src, alt: file.name.replace(/\.[^.]+$/, '') || 'image' } }
          if (insertPos !== null) {
            editor.chain().focus().insertContentAt(insertPos, node).run()
            insertPos = null
          } else {
            editor.chain().focus().insertContent(node).run()
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setUploading((n) => Math.max(0, n - files.length))
      }
    },
    [assetDate]
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
        codeBlock: { exitOnTripleEnter: true, exitOnArrowDown: true }
      }),
      Markdown,
      DevlogImage,
      Placeholder.configure({ placeholder }),
      SubmitKeymap.configure({
        onSubmit: () => submitRef.current(),
        onCancel: () => cancelRef.current()
      })
    ],
    content: startContent,
    contentType: 'markdown',
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'composer-editor', spellcheck: 'true' },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(isImageFile)
        if (files.length === 0) return false
        event.preventDefault()
        void uploadImages(files, view)
        return true
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false
        const files = Array.from(event.dataTransfer?.files ?? []).filter(isImageFile)
        if (files.length === 0) return false
        event.preventDefault()
        void uploadImages(files, view, { left: event.clientX, top: event.clientY })
        return true
      }
    },
    onTransaction: () => forceRender((n) => n + 1),
    onUpdate: ({ editor: e }) => {
      if (!draftKey) return
      try {
        const md = e.getMarkdown()
        if (isBlankMarkdown(md)) localStorage.removeItem(draftKey)
        else localStorage.setItem(draftKey, md)
      } catch {
        /* ignore quota errors */
      }
    }
  })
  editorRef.current = editor

  const submit = useCallback((): boolean => {
    const e = editorRef.current
    if (!e || busy || uploading > 0) return true
    const markdown = e.getMarkdown().trim()
    if (isBlankMarkdown(markdown)) return true
    setBusy(true)
    setError(null)
    // Clear optimistically (like Slack) so keystrokes typed while the post is
    // being written are not lost; restore the draft if the write fails.
    const snapshot = e.getJSON()
    if (mode === 'new') {
      e.commands.clearContent(true)
      clearDraft(draftKey)
    }
    onSubmit(markdown)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        if (mode === 'new' && isBlankMarkdown(e.getText()) && !hasContent(e)) e.commands.setContent(snapshot)
      })
      .finally(() => setBusy(false))
    return true
  }, [busy, uploading, onSubmit, mode, draftKey])

  const cancel = useCallback((): boolean => {
    if (linkOpen) {
      setLinkOpen(false)
      return true
    }
    if (onCancel) {
      onCancel()
      return true
    }
    return false
  }, [linkOpen, onCancel])

  submitRef.current = submit
  cancelRef.current = cancel

  useEffect(() => {
    if (focusToken !== undefined && editor) editor.commands.focus('end')
  }, [focusToken, editor])

  const openLink = (): void => {
    if (!editor) return
    const existing = (editor.getAttributes('link').href as string | undefined) ?? ''
    setLinkUrl(existing)
    setLinkOpen(true)
  }

  const applyLink = (): void => {
    if (!editor) return
    const url = linkUrl.trim()
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
    } else {
      const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
      if (editor.state.selection.empty && !editor.isActive('link')) {
        editor.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run()
      } else {
        editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
      }
    }
    setLinkOpen(false)
  }

  const canPost = !!editor && !busy && uploading === 0 && hasContent(editor)

  return (
    <div className={`composer composer-${mode}${busy ? ' is-busy' : ''}`}>
      <div className="composer-toolbar" role="toolbar" aria-label="Formatting">
        {TOOLS.map((t) => (
          <button
            key={t.title}
            type="button"
            className={`tb${t.className ? ` ${t.className}` : ''}${editor && t.isActive?.(editor) ? ' is-active' : ''}`}
            title={t.title}
            disabled={!editor}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => editor && t.run(editor)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className={`tb${editor?.isActive('link') ? ' is-active' : ''}`}
          title="Link (⌘K)"
          disabled={!editor}
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={openLink}
        >
          🔗
        </button>
        {linkOpen && (
          <form
            className="link-form"
            onSubmit={(ev) => {
              ev.preventDefault()
              applyLink()
            }}
          >
            <input
              autoFocus
              type="text"
              placeholder="https://…"
              value={linkUrl}
              onChange={(ev) => setLinkUrl(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Escape') {
                  ev.preventDefault()
                  setLinkOpen(false)
                  editor?.commands.focus()
                }
              }}
            />
            <button type="submit">Apply</button>
            <button type="button" onClick={() => setLinkOpen(false)}>
              Cancel
            </button>
          </form>
        )}
      </div>

      <EditorContent editor={editor} className="composer-content" />

      <div className="composer-footer">
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(ev) => {
            const files = Array.from(ev.target.files ?? []).filter(isImageFile)
            ev.target.value = ''
            void uploadImages(files)
          }}
        />
        <button
          type="button"
          className="tb tb-attach"
          title="Attach image (or paste / drop one)"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => fileInput.current?.click()}
        >
          ＋ Image
        </button>
        <span className="composer-hint">
          {uploading > 0
            ? `Saving ${uploading} image${uploading > 1 ? 's' : ''}…`
            : error
              ? <span className="composer-error">{error}</span>
              : mode === 'edit'
                ? 'Enter to save · Esc to cancel'
                : 'Enter to post · Shift+Enter for a new line'}
        </span>
        <span className="spacer" />
        {mode === 'edit' && (
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canPost}
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => submit()}
        >
          {busy ? (mode === 'edit' ? 'Saving…' : 'Posting…') : mode === 'edit' ? 'Save' : 'Post'}
        </button>
      </div>
    </div>
  )
}
