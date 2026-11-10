/**
 * Delta's plugin store, kept as JSON files under the Harness home.
 *
 * Claude Code gives its plugins one JSON store shared by every session on the
 * machine: `get`/`set`/`delete` by string key and `keys()` for cleanup. Delta
 * keeps each session's binding, outbox frontier and one-time notices there. The
 * Harness has no such generic store for third-party plugins, so this module
 * implements the same operations over one JSON file per key beneath
 * `$DSH_HOME/delta-dsh/store`.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The four-part store Delta's `Host` binds: JSON values by string key. */
export class FileStore {
  constructor(directory) {
    this.directory = directory
    this.ready = undefined
  }

  async ensure() {
    this.ready ??= mkdir(this.directory, { recursive: true })
    await this.ready
  }

  /** One key's file name: percent-encoded, so ':' and '/' stay inside the directory. */
  fileFor(key) {
    return join(this.directory, `${encodeURIComponent(key)}.json`)
  }

  async get(key) {
    try {
      return JSON.parse(await readFile(this.fileFor(key), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async set(key, value) {
    await this.ensure()
    const text = JSON.stringify(value)
    if (text === undefined) throw new Error(`Delta store refuses a value that is not JSON for key ${key}`)
    const path = this.fileFor(key)
    const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, path)
  }

  async delete(key) {
    await rm(this.fileFor(key), { force: true })
  }

  async keys() {
    await this.ensure()
    const names = await readdir(this.directory)
    return names
      .filter((name) => name.endsWith('.json') && !name.includes('.tmp'))
      .map((name) => decodeURIComponent(name.slice(0, -'.json'.length)))
  }
}
