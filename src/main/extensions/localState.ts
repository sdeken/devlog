/**
 * Machine-local extension state, kept in user data and never in a devlog:
 * consent (which exact extension build you allowed in which devlog, and
 * with what read/write scopes) and secrets (encrypted with the OS keychain).
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sanitizeGrant, type Grant } from '@devlog/core'

export interface Consent {
  /** The build that was allowed; a different hash asks again. */
  sha256: string
  grant: Grant
  at: string
}

type ConsentFile = { devlogs: Record<string, Record<string, Consent>> }

/** A short, stable key for a devlog folder. */
export function devlogKey(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16)
}

export class ConsentStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  private async read(): Promise<ConsentFile> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as ConsentFile
      if (raw && typeof raw.devlogs === 'object') return raw
    } catch {
      /* none yet */
    }
    return { devlogs: {} }
  }

  async get(root: string, id: string): Promise<Consent | null> {
    const c = (await this.read()).devlogs[devlogKey(root)]?.[id]
    return c ? { sha256: String(c.sha256), grant: sanitizeGrant(c.grant), at: String(c.at) } : null
  }

  set(root: string, id: string, consent: Consent | null): Promise<void> {
    const run = this.queue.then(async () => {
      const data = await this.read()
      const key = devlogKey(root)
      const forDevlog = { ...(data.devlogs[key] ?? {}) }
      if (consent) forDevlog[id] = { ...consent, grant: sanitizeGrant(consent.grant) }
      else delete forDevlog[id]
      data.devlogs[key] = forDevlog
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, JSON.stringify(data, null, 2))
      await fs.rename(tmp, this.file)
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}

export interface Cipher {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

/** Per-extension secrets, one encrypted file each. */
export class SecretStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly cipher: Cipher
  ) {}

  private file(id: string): string {
    if (!/^[a-z0-9._-]+$/.test(id)) throw new Error('Bad extension id')
    return path.join(this.dir, `${id}.json`)
  }

  private async read(id: string): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  async get(id: string, key: string): Promise<string | undefined> {
    const enc = (await this.read(id))[key]
    if (enc === undefined) return undefined
    if (!this.cipher.available()) throw new Error('The OS keychain is not available, so secrets cannot be read')
    return this.cipher.decrypt(Buffer.from(enc, 'base64'))
  }

  async has(id: string, key: string): Promise<boolean> {
    return (await this.read(id))[key] !== undefined
  }

  set(id: string, key: string, value: string | null): Promise<void> {
    const run = this.queue.then(async () => {
      const data = await this.read(id)
      if (value === null) delete data[key]
      else {
        if (!this.cipher.available()) throw new Error('The OS keychain is not available, so secrets cannot be stored')
        data[key] = this.cipher.encrypt(value).toString('base64')
      }
      await fs.mkdir(this.dir, { recursive: true })
      const tmp = `${this.file(id)}.tmp`
      await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 })
      await fs.rename(tmp, this.file(id))
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}
