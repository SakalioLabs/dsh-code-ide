import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

const PLUGIN_ID = 'dsh-code-ide'

/**
 * Emit the browser half in Harness' closure-factory format. Runtime identities
 * stay in the shell's frozen module table; this tiny contribution only needs
 * React's JSX runtime at value level.
 */
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('./dist/harness-client', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('./src/harness-client/index.tsx', import.meta.url)),
      formats: ['cjs'],
      fileName: () => 'client.js',
    },
    rollupOptions: {
      external: [
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/client',
        '@deepseek-ai/cordis',
      ],
      output: {
        entryFileNames: 'client.js',
        exports: 'named',
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
        intro: 'var module = { exports: {} }; var exports = module.exports;',
        footer: 'return module.exports; } });',
      },
    },
  },
})
