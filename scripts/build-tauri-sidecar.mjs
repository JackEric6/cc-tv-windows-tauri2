import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'dist/backend.cjs')
const runtime = resolve(root, 'src-tauri/resources/node.exe')

await mkdir(dirname(output), { recursive: true })
await mkdir(dirname(runtime), { recursive: true })
await build({
  entryPoints: [resolve(root, 'src/tauri/backend.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  packages: 'bundle',
  external: ['node:*']
})
await copyFile(process.execPath, runtime)
process.stdout.write(`Built sidecar and copied ${process.execPath}\n`)
