const esbuild = require('esbuild')
const path = require('path')

const root = path.resolve(__dirname, '..', '..', '..')

// Bundle client
esbuild.buildSync({
    entryPoints: ['src/client.ts'],
    bundle: true,
    outfile: 'dist/client.js',
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
})

// Bundle server — inlines all dependencies including @words-lang/parser
esbuild.buildSync({
    entryPoints: [path.join(root, 'packages/lsp/src/server.ts')],
    bundle: true,
    outfile: 'dist/server/server.js',
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    // Tell esbuild where to find packages from the monorepo root
    nodePaths: [path.join(root, 'node_modules')],
})

console.log('Bundled client and server.')