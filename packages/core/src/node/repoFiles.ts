/** Small repository housekeeping files, and the list of block files. */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Block files and activity logs are append-only, so when two machines both
 * append, keeping both sides' lines is always the right merge; git's
 * built-in union driver does exactly that instead of reporting a conflict.
 */
export const GITATTRIBUTES_LINES = ['**/entries/**/*.md merge=union', '**/todos.md merge=union', 'activity/**/*.jsonl merge=union']

export const GITIGNORE_LINES = ['.DS_Store', 'Thumbs.db']

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

/** A block file in the sharded layout: a day file or a todo list. */
export interface BlockFileRef {
  /** Repo-relative POSIX path. */
  rel: string
  /** Its title line (`# 2026-09-19`, `# Todos`). */
  title: string
  /** Creation time for blocks that lack one (day files: the start of the day). */
  fallbackCreatedAt?: string
}

const YEAR_RE = /^\d{4}$/
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/

/** Every block file in the repository: the journal's and each canvas's. */
export async function listBlockFiles(root: string): Promise<BlockFileRef[]> {
  const out: BlockFileRef[] = []
  const stream = async (base: string): Promise<void> => {
    const absBase = path.join(root, ...base.split('/'))
    for (const y of await readdirSafe(absBase)) {
      if (y.isFile() && y.name === 'todos.md') out.push({ rel: `${base}/${y.name}`, title: '# Todos' })
      if (!y.isDirectory() || !YEAR_RE.test(y.name)) continue
      for (const m of await readdirSafe(path.join(absBase, y.name))) {
        if (!m.isDirectory()) continue
        for (const f of await readdirSafe(path.join(absBase, y.name, m.name))) {
          const date = f.isFile() ? DAY_FILE_RE.exec(f.name)?.[1] : undefined
          if (date && date.startsWith(`${y.name}-${m.name}`)) {
            out.push({ rel: `${base}/${y.name}/${m.name}/${f.name}`, title: `# ${date}`, fallbackCreatedAt: `${date}T00:00:00.000Z` })
          }
        }
      }
    }
  }
  await stream('entries')
  for (const shard of await readdirSafe(path.join(root, 'canvases'))) {
    if (!shard.isDirectory()) continue
    for (const c of await readdirSafe(path.join(root, 'canvases', shard.name))) {
      if (!c.isDirectory()) continue
      const dir = `canvases/${shard.name}/${c.name}`
      for (const f of await readdirSafe(path.join(root, 'canvases', shard.name, c.name))) {
        if (f.isFile() && f.name === 'todos.md') out.push({ rel: `${dir}/todos.md`, title: '# Todos' })
      }
      await stream(`${dir}/entries`)
    }
  }
  return out
}

async function readdirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}
