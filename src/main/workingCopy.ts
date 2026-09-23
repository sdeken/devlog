/** Checks that a folder picked for linking is a git working copy. Pure Node, no Electron. */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { simpleGit } from 'simple-git'

export type WorkingCopyCheck = { ok: true; root: string } | { ok: false; error: string }

/**
 * Is `dir` a git working copy we can watch? Returns its top-level folder (a
 * subfolder of a repository resolves to the repository), or why not.
 */
export async function inspectWorkingCopy(dir: string, devlogRoot: string | null): Promise<WorkingCopyCheck> {
  const name = path.basename(dir) || dir
  try {
    const st = await fs.stat(dir)
    if (!st.isDirectory()) return { ok: false, error: `${name} is not a folder` }
  } catch {
    return { ok: false, error: `${name} does not exist` }
  }
  let root: string
  try {
    root = (await simpleGit({ baseDir: dir }).revparse(['--show-toplevel'])).trim()
  } catch {
    return { ok: false, error: `${name} is not a git repository` }
  }
  if (!root) return { ok: false, error: `${name} is not a git repository` }
  root = path.resolve(root)
  if (devlogRoot && path.resolve(devlogRoot) === root) return { ok: false, error: 'That is the devlog repository itself; link the working copy you code in' }
  return { ok: true, root }
}

