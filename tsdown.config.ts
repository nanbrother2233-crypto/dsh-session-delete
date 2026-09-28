import { defineConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-session-delete'

/**
 * The browser half must ship as a *built* CJS-factory bundle: the host serves
 * `lib/client.js` verbatim and the shell materializes it through
 * `window.__ModuleLoader__.load`. Everything the shell already seeds
 * (react, react/jsx-runtime, cordis, client-store, ui-slots, ui-primitives) is
 * external — only our own source is inlined.
 *
 * `id` here is the package name, which must equal `package.json.name`: the
 * shell keys the boot graph on the resolved manifest package name.
 */
export default defineConfig({
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.tsx' },
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  // `deps.neverBundle` is the current spelling of the old top-level `external`
  // (tsdown assigns one from the other, and refusing both together). The list
  // must stay in step with `dsh.client.inject` in package.json.
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-store',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
