/** Small repository housekeeping files the store and the migrations share. */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Block files and activity logs are append-only, so when two machines both
 * append, keeping both sides' lines is always the right merge; git's
 * built-in union driver does exactly that instead of reporting a conflict.
 */
export const GITATTRIBUTES_LINES = ['**/entries/**/*.md merge=union', '**/todos.md merge=union', 'activity/**/*.jsonl merge=union']

export const GITIGNORE_LINES = ['.DS_Store', 'Thumbs.db', '.devlog-migrate/', '.devlog-migrate-old/']

/** Append any of `lines` missing from `file` (created if needed). Leaves everything else as it is. */
export async function ensureLines(file: string, lines: string[], comment?: string): Promise<void> {
  const current = await fs.readFile(file, 'utf8').catch(() => '')
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()))
  const missing = lines.filter((l) => !have.has(l))
  if (missing.length === 0) return
  const block = [...(comment && !have.has(comment) ? [comment] : []), ...missing]
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${current.replace(/\s*$/, '')}${current.trim() ? '\n' : ''}${block.join('\n')}\n`)
}

export async function ensureRepoFiles(root: string): Promise<void> {
  await ensureLines(path.join(root, '.gitignore'), GITIGNORE_LINES)
  await ensureLines(path.join(root, '.gitattributes'), GITATTRIBUTES_LINES, '# Devlog: append-only files merge by keeping both sides')
}
