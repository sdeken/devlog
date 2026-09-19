import { Extension, mergeAttributes } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { fromAssetUrl, toAssetUrl } from '@renderer/assets'

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
  onCancel: () => boolean
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
    return { onSubmit: () => false, onCancel: () => false }
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { $from } = this.editor.state.selection
        if ($from.parent.type.name === 'codeBlock') return false
        for (let depth = $from.depth; depth > 0; depth--) {
          const name = $from.node(depth).type.name
          if (name === 'listItem' || name === 'taskItem') return false
        }
        return this.options.onSubmit()
      },
      'Shift-Enter': () => {
        const { $from } = this.editor.state.selection
        if ($from.parent.type.name === 'codeBlock') return this.editor.commands.insertContent('\n')
        for (let depth = $from.depth; depth > 0; depth--) {
          const name = $from.node(depth).type.name
          if (name === 'listItem' || name === 'taskItem') return false // hard break inside the item
        }
        return this.editor.commands.splitBlock()
      },
      'Mod-Enter': () => this.options.onSubmit(),
      Escape: () => this.options.onCancel()
    }
  }
})
