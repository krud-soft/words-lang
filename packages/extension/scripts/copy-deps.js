/**
 * copy-deps.js
 *
 * Copies the compiled LSP server and parser library into the extension's
 * dist folder so they are bundled inside the .vsix and available at runtime
 * regardless of the user's directory structure.
 *
 * Output structure inside dist/:
 *   dist/server/        ← lsp/dist contents
 *   dist/parser/        ← parser/dist contents
 */

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', '..', '..')  // monorepo root
const extensionDist = path.resolve(__dirname, '..', 'dist')

const copies = [
    {
        src: path.join(root, 'packages', 'lsp', 'dist'),
        dest: path.join(extensionDist, 'server'),
    },
    {
        src: path.join(root, 'packages', 'parser', 'dist'),
        dest: path.join(extensionDist, 'parser'),
    },
]

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name)
        const destPath = path.join(dest, entry.name)
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath)
        } else {
            fs.copyFileSync(srcPath, destPath)
        }
    }
}

for (const { src, dest } of copies) {
    if (!fs.existsSync(src)) {
        console.error(`Source not found: ${src}`)
        console.error('Run npm run build in packages/lsp and packages/parser first.')
        process.exit(1)
    }
    copyDir(src, dest)
    console.log(`Copied ${path.relative(root, src)} → ${path.relative(root, dest)}`)
}

console.log('Done.')