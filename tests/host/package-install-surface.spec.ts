import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '..', '..')

describe('Git install surface', () => {
  it('does not define lifecycle scripts that build on a user machine', async () => {
    const manifest = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const lifecycleScripts = ['prepare', 'prepack', 'preinstall', 'install', 'postinstall']

    expect(lifecycleScripts.filter(name => Object.hasOwn(manifest.scripts ?? {}, name))).toEqual([])
  })

  it('ships every entry point required by a source-based Harness install', async () => {
    await Promise.all([
      'dist/host/index.js',
      'dist/client/index.html',
      'dist/harness-client/client.js',
      'cordis.patch.yml',
    ].map(path => access(resolve(repositoryRoot, path))))
  })
})
