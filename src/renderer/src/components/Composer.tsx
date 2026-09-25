import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from '@tiptap/markdown'
import type { EditorView } from '@tiptap/pm/view'
import { isBlankMarkdown, localDate } from '@devlog/core'
import { api } from '@renderer/api'
import { DevlogCodeBlock, DevlogImage, SubmitKeymap } from '@renderer/editor/extensions'
import { clearActiveComposer, setActiveComposer } from '@renderer/editor/active'
import { kbd } from '@renderer/keys'
import { detectCodePaste } from '@renderer/editor/smartPaste'
import type { CanvasMeta } from '@shared/types'
import { JOURNAL_ID, buildCanvasTree, flattenTree } from '@devlog/core'

export type ComposerMode = 'new' | 'edit' | 'reply' | 'insert' | 'document'

export interface ComposerProps {
  mode: ComposerMode
  initialMarkdown?: string
  placeholder?: string
  autoFocus?: boolean
  /** Canvas whose asset folder receives pasted images (unless `saveImage` is given). */
  assetCanvasId?: string
  /** Day whose asset folder receives pasted images. Defaults to today. */
  assetDate?: string
  /** Custom image sink (e.g. a wiki's asset folder). */
  saveImage?: (bytes: Uint8Array, mime: string, name: string) => Promise<{ src: string }>
  /** Called with markdown when the user posts. Resolve to clear the editor. `task` is set for Mod+Shift+Enter. */
  onSubmit: (markdown: string, opts?: { task?: boolean }) => Promise<void>
  /** Document mode: called (debounced) whenever the content changes. */
  onChange?: (markdown: string) => Promise<void> | void
  onCancel?: () => void
  /** Up arrow in an empty composer (new mode only). */
  onEditLast?: () => void
  /** Persist draft under this key in localStorage (new mode). */
  draftKey?: string
  focusToken?: number
  /** New mode: offer a canvas picker so a block can be posted anywhere from here. */
  canvases?: CanvasMeta[]
  targetCanvasId?: string
  onTargetChange?: (canvasId: string) => void
}

const PLACEHOLDER: Record<ComposerMode, string> = {
  new: `Write a block…  Enter posts, ${kbd('mod', 'shift', 'Enter')} posts as a task, Shift+Enter new line`,
  edit: 'Edit block…  Enter saves, Esc cancels',
  reply: 'Reply…  Enter posts, Esc cancels',
  insert: 'New block here…  Enter posts, Esc cancels',
  document: 'Write anything…'
}

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
  placeholder,
  autoFocus = false,
  assetCanvasId,
  assetDate,
  saveImage,
  onSubmit,
  onChange,
  onCancel,
  onEditLast,
  draftKey,
  focusToken,
  canvases,
  targetCanvasId,
  onTargetChange
}: ComposerProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(0)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [, forceRender] = useState(0)
  const renderQueued = useRef(false)
  const submitRef = useRef<(opts?: { task?: boolean }) => boolean>(() => false)
  const cancelRef = useRef<() => boolean>(() => false)
  const linkRef = useRef<() => boolean>(() => false)
  const editLastRef = useRef<(() => void) | undefined>(onEditLast)
  editLastRef.current = onEditLast
  const editorRef = useRef<Editor | null>(null)
  const isDocument = mode === 'document'
  const changeRef = useRef(onChange)
  changeRef.current = onChange
  const changeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingDoc = useRef<string | null>(null)
  const flushChange = (): void => {
    if (changeTimer.current) clearTimeout(changeTimer.current)
    changeTimer.current = null
    if (pendingDoc.current !== null && changeRef.current) {
      const md = pendingDoc.current
      pendingDoc.current = null
      void changeRef.current(md)
    }
  }
  const flushRef = useRef(flushChange)
  flushRef.current = flushChange

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
          const saved = saveImage
            ? await saveImage(bytes, file.type, file.name)
            : await api.assets.save(assetCanvasId ?? 'journal', date, bytes, file.type, file.name)
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
    [assetCanvasId, assetDate, saveImage]
  )
  const sinkRef = useRef<(files: File[]) => void>(() => undefined)
  sinkRef.current = (files) => void uploadImages(files)
  const sink = useMemo(() => (files: File[]) => sinkRef.current(files), [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
        codeBlock: false
      }),
      DevlogCodeBlock,
      Markdown,
      DevlogImage,
      Placeholder.configure({ placeholder: placeholder ?? PLACEHOLDER[mode] }),
      SubmitKeymap.configure({
        onSubmit: () => (isDocument ? false : submitRef.current()),
        onSubmitTask: () => (isDocument || mode !== 'new' ? false : submitRef.current({ task: true })),
        onCancel: () => (isDocument ? false : cancelRef.current()),
        onLink: () => linkRef.current(),
        onEditLast: () => {
          if (mode !== 'new' || !editLastRef.current) return false
          editLastRef.current()
          return true
        }
      })
    ],
    content: startContent,
    contentType: 'markdown',
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'composer-editor', spellcheck: 'true' },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter(isImageFile)
        if (files.length > 0) {
          event.preventDefault()
          void uploadImages(files, view)
          return true
        }
        // Plain-text evidence (stack traces, logs, diffs) goes into a code block as-is.
        const html = event.clipboardData?.getData('text/html') ?? ''
        const text = event.clipboardData?.getData('text/plain') ?? ''
        if (text && (!html || /<pre|<code/i.test(html))) {
          const code = detectCodePaste(text)
          if (code) {
            event.preventDefault()
            const e = editorRef.current
            if (!e) return false
            const content = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
            const inCode = e.isActive('codeBlock')
            if (inCode) e.chain().focus().insertContent(content).run()
            else {
              e.chain()
                .focus()
                .insertContent({ type: 'codeBlock', attrs: { language: code.language || null }, content: [{ type: 'text', text: content }] })
                .run()
            }
            return true
          }
        }
        return false
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
    onFocus: () => setActiveComposer(sink),
    // Toolbar state follows the selection. Re-render at most once per frame: a
    // burst of transactions (mounting, pasting, highlighting) must not become a
    // burst of synchronous React updates.
    onTransaction: () => {
      if (renderQueued.current) return
      renderQueued.current = true
      requestAnimationFrame(() => {
        renderQueued.current = false
        forceRender((n) => n + 1)
      })
    },
    onUpdate: ({ editor: e }) => {
      if (isDocument) {
        pendingDoc.current = e.getMarkdown()
        if (changeTimer.current) clearTimeout(changeTimer.current)
        changeTimer.current = setTimeout(() => flushRef.current(), 800)
        return
      }
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

  // Any composer that mounts with focus (edit/reply/insert) becomes the image target.
  useEffect(() => {
    if (autoFocus) setActiveComposer(sink)
    return () => clearActiveComposer(sink)
  }, [autoFocus, sink])

  // Edits in progress hold off an update restart. New-note drafts persist in
  // localStorage, so only edit/reply/insert composers and pending wiki saves count.
  const busyRef = useRef(false)
  const setBusy_ = (b: boolean): void => {
    if (busyRef.current === b) return
    busyRef.current = b
    api.updates.setEditorBusy(b)
  }
  useEffect(() => {
    if (mode === 'new') return
    const tick = setInterval(() => {
      const e = editorRef.current
      const dirty = isDocument ? pendingDoc.current !== null : !!e && hasContent(e)
      setBusy_(dirty)
    }, 1000)
    return () => {
      clearInterval(tick)
      setBusy_(false)
    }
  }, [mode, isDocument])

  // Document mode: never lose the last edit when the view or the window goes away.
  useEffect(() => {
    if (!isDocument) return
    const flush = (): void => flushRef.current()
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
      flush()
    }
  }, [isDocument])

  const submit = useCallback((opts?: { task?: boolean }): boolean => {
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
    onSubmit(markdown, opts)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        if (mode === 'new' && !hasContent(e)) e.commands.setContent(snapshot)
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
    setLinkUrl((editor.getAttributes('link').href as string | undefined) ?? '')
    setLinkOpen(true)
  }
  linkRef.current = () => {
    if (!editor || (editor.state.selection.empty && !editor.isActive('link'))) return false
    openLink()
    return true
  }

  const applyLink = (): void => {
    if (!editor) return
    const url = linkUrl.trim()
    if (!url) editor.chain().focus().extendMarkRange('link').unsetLink().run()
    else {
      const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    }
    setLinkOpen(false)
  }

  const marks: Array<{ key: string; label: string; title: string; cls?: string; active: boolean; run: () => void }> = editor
    ? [
        { key: 'bold', label: 'B', title: `Bold ${kbd('mod', 'B')}`, cls: 'bm-bold', active: editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run() },
        { key: 'italic', label: 'I', title: `Italic ${kbd('mod', 'I')}`, cls: 'bm-italic', active: editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run() },
        { key: 'strike', label: 'S', title: `Strikethrough ${kbd('mod', 'shift', 'X')}`, cls: 'bm-strike', active: editor.isActive('strike'), run: () => editor.chain().focus().toggleStrike().run() },
        { key: 'code', label: '</>', title: `Code ${kbd('mod', 'E')}`, cls: 'bm-code', active: editor.isActive('code'), run: () => editor.chain().focus().toggleCode().run() },
        { key: 'link', label: '🔗', title: `Link ${kbd('mod', 'K')}`, active: editor.isActive('link'), run: openLink }
      ]
    : []

  const status = uploading > 0 ? `Saving ${uploading} image${uploading > 1 ? 's' : ''}…` : error

  return (
    <div className={`composer composer-${mode}${busy ? ' is-busy' : ''}`}>
      {editor && (
        <BubbleMenu
          editor={editor}
          className="bubble-menu"
          options={{ placement: 'top', offset: 6 }}
          shouldShow={({ editor: e, from, to }) => {
            if (linkOpen) return true
            if (from === to) return false
            return !e.isActive('codeBlock') && !e.isActive('image')
          }}
        >
          {linkOpen ? (
            <form
              className="bubble-link"
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
                    editor.commands.focus()
                  }
                }}
              />
              <button type="submit" title="Apply">
                ↵
              </button>
            </form>
          ) : (
            marks.map((m) => (
              <button
                key={m.key}
                type="button"
                className={`bm${m.cls ? ` ${m.cls}` : ''}${m.active ? ' is-active' : ''}`}
                title={m.title}
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={m.run}
              >
                {m.label}
              </button>
            ))
          )}
        </BubbleMenu>
      )}
      <EditorContent editor={editor} className="composer-content" />
      {(status || (mode === 'new' && canvases && onTargetChange)) && (
        <div className="composer-foot">
          {mode === 'new' && canvases && onTargetChange && (
            <label className="composer-target" title="Which canvas this block posts to">
              <span className="composer-target-icon">▤</span>
              <select value={targetCanvasId ?? JOURNAL_ID} onChange={(ev) => onTargetChange(ev.target.value)}>
                <option value={JOURNAL_ID}>Journal</option>
                {flattenTree(buildCanvasTree(canvases)).map(({ canvas: c, depth }) => (
                  <option key={c.id} value={c.id}>
                    {'\u00a0\u00a0'.repeat(depth)}
                    {c.task ? '◉ ' : ''}
                    {c.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          {status && <span className={`composer-status${error ? ' is-error' : ''}`}>{status}</span>}
        </div>
      )}
    </div>
  )
}
