/**
 * Build dist/bkms-workbench-<version>.tgz with every runtime dependency inside (bundleDependencies), so the plugin can
 * be installed on a machine without access to npm or GitHub (zq-sqlite is a Git dependency).
 *
 * pnpm only bundles dependencies from a flat node_modules, so the package is staged in a temporary folder: the files
 * that are published, a package.json listing the bundled dependencies, and a production-only hoisted install.
 * Run after `pnpm run build` (`pnpm run pack:plugin` does both).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (!existsSync(join(root, 'lib', 'index.js')) || !existsSync(join(root, 'lib', 'client.js'))) throw new Error('Build first: pnpm run build')
const stage = mkdtempSync(join(tmpdir(), 'bkms-workbench-pack-'))
const pnpm = (args, cwd) => execFileSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
try {
  for (const entry of pkg.files) if (existsSync(join(root, entry))) cpSync(join(root, entry), join(stage, entry), { recursive: true })
  const { devDependencies, scripts, ...published } = pkg
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ ...published, bundleDependencies: Object.keys(pkg.dependencies) }, null, 2) + '\n')
  // The same versions as in development: start from this repository's lockfile.
  cpSync(join(root, 'pnpm-lock.yaml'), join(stage, 'pnpm-lock.yaml'))
  writeFileSync(join(stage, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\n')
  pnpm(['install', '--prod', '--ignore-scripts', '--config.confirm-modules-purge=false'], stage)
  const dist = join(root, 'dist')
  mkdirSync(dist, { recursive: true })
  pnpm(['pack', '--pack-destination', dist], stage)
  const file = readdirSync(dist).find(name => name === `${pkg.name}-${pkg.version}.tgz`)
  console.log(`dist/${file} (dependencies bundled: ${Object.keys(pkg.dependencies).join(', ')})`)
} finally {
  rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
