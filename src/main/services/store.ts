import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app } from '../../tauri/platform'

/**
 * 极简 JSON 文件存储：内存缓存 + 防抖落盘。
 * 不引入原生数据库模块，保证 clone 下来就能跑。
 */

const memory = new Map<string, unknown>()
const dirty = new Set<string>()
const timers = new Map<string, NodeJS.Timeout>()
const revisions = new Map<string, number>()
const DEBOUNCE_MS = 200
const RETRY_MS = 1_000

function fileOf(name: string): string {
  return join(app.getPath('userData'), `${name}.json`)
}

export async function readStore<T>(name: string, fallback: T): Promise<T> {
  if (memory.has(name)) return memory.get(name) as T
  try {
    const text = await fs.readFile(fileOf(name), 'utf-8')
    const data = JSON.parse(text) as T
    memory.set(name, data)
    return data
  } catch {
    memory.set(name, fallback)
    return fallback
  }
}

export function writeStore<T>(name: string, data: T): void {
  memory.set(name, data)
  dirty.add(name)
  revisions.set(name, (revisions.get(name) ?? 0) + 1)
  const old = timers.get(name)
  if (old) clearTimeout(old)
  timers.set(
    name,
    setTimeout(() => {
      void flushStore(name)
    }, DEBOUNCE_MS)
  )
}

export async function flushStore(name?: string): Promise<void> {
  const names = name ? [name] : [...dirty]
  await Promise.all(
    names.map(async (n) => {
      if (!dirty.has(n)) return
      const t = timers.get(n)
      if (t) {
        clearTimeout(t)
        timers.delete(n)
      }
      const revision = revisions.get(n) ?? 0
      const target = fileOf(n)
      const tmp = `${target}.tmp`
      try {
        await fs.mkdir(app.getPath('userData'), { recursive: true })
        await fs.writeFile(tmp, JSON.stringify(memory.get(n), null, 2), 'utf-8')
        try {
          await fs.rename(tmp, target)
        } catch (error) {
          // Windows refuses to replace an existing file with rename(). Keep the
          // temp-file write, then replace the old file explicitly.
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'EEXIST' && code !== 'EPERM') throw error
          await fs.rm(target, { force: true })
          await fs.rename(tmp, target)
        }
        // A write may have happened while the disk operation was in flight.
        // Only clear the dirty flag when this flush wrote the latest revision.
        if (revisions.get(n) === revision) dirty.delete(n)
      } catch (err) {
        console.error(`[store] 写入 ${n}.json 失败`, err)
        // Keep failed data eligible for a later retry. A newer write already
        // scheduled its own timer, so only schedule a retry when none exists.
        if (!timers.has(n)) {
          timers.set(n, setTimeout(() => { void flushStore(n) }, RETRY_MS))
        }
      } finally {
        // A failed rename can leave the temporary file behind; it is safe to
        // remove it because every flush writes a complete fresh snapshot.
        await fs.rm(tmp, { force: true }).catch(() => undefined)
      }
    })
  )
}

/** 供调试与「打开数据目录」使用 */
export function storePath(name: string): string {
  return fileOf(name)
}
