import { Extension, mergeAttributes } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { common, createLowlight } from 'lowlight'
import { fromAssetUrl, toAssetUrl } from '@renderer/assets'

export const lowlight = createLowlight(common)

/** Fenced code blocks with syntax highlighting; markdown in/out keeps the language tag. */
export const DevlogCodeBlock = CodeBlockLowlight.configure({
  lowlight,
  defaultLanguage: null,
  exitOnTripleEnter: true,
  exitOnArrowDown: true
})

/**
 * Image node whose `src` attribute is a repo-root-relative path (what gets
 * serialised to markdown) but which renders through the `devlog://` scheme.
 */
export const DevlogImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (el: HTMLElement) => fromAssetUrl(el.getAttribute('src'))
      }
    }
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'img',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        src: toAssetUrl(node.attrs.src as string),
        draggable: 'false'
      })
    ]
  }
}).configure({ inline: false, allowBase64: false })

export interface SubmitKeymapOptions {
  onSubmit: () => boolean
  /** Mod+Shift+Enter: post and turn the block into a task. */
  onSubmitTask: () => boolean
  onCancel: () => boolean
  /** Up arrow in an empty editor: edit the previous note (Slack behaviour). */
  onEditLast: () => boolean
  /** Mod+K: open the link editor. */
  onLink: () => boolean
}

/**
 * Slack-style keys: Enter posts, Shift+Enter starts a new line, Mod+Enter
 * always posts. Inside code blocks and lists Enter keeps its editing meaning.
 *
 * Shift+Enter in a paragraph starts a new paragraph (rather than a hard
 * break) so the markdown shortcuts (`- `, `1. `, `> `, `# `, "```") work at
 * the start of every line, and the stored markdown stays plain.
 */
export const SubmitKeymap = Extension.create<SubmitKeymapOptions>({
  name: 'submitKeymap',
  priority: 1000,

  addOptions() {
    return { onSubmit: () => false, onSubmitTask: () => false, onCancel: () => false, onEditLast: () => false, onLink: () => false }
  },

  addKeyboardShortcuts() {
    const inside = (names: string[]): boolean => {
      const { $from } = this.editor.state.selection
      for (let depth = $from.depth; depth > 0; depth--) {
        if (names.includes($from.node(depth).type.name)) return true
      }
      return false
    }
    return {
      Enter: () => {
        const { $from } = this.editor.state.selection
        if ($from.parent.type.name === 'codeBlock') return false
        if (inside(['listItem', 'taskItem'])) return false
        // "```lang" + Enter must open a code block (TipTap's input rules run on Enter after us).
        if (/^(```|~~~)[a-z0-9+#-]*$/i.test($from.parent.textContent.trim())) return false
        return this.options.onSubmit()
      },
      'Shift-Enter': () => {
        if (this.editor.state.selection.$from.parent.type.name === 'codeBlock') {
          return this.editor.commands.insertContent('\n')
        }
        if (inside(['listItem', 'taskItem'])) return false // hard break inside the item
        return this.editor.commands.splitBlock()
      },
      'Mod-Enter': () => this.options.onSubmit(),
      'Mod-Shift-Enter': () => this.options.onSubmitTask(),
      Escape: () => this.options.onCancel(),
      ArrowUp: () => {
        if (this.editor.isEmpty) return this.options.onEditLast()
        return false
      },
      'Mod-k': () => this.options.onLink()
    }
  }
})
