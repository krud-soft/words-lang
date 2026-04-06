#!/usr/bin/env node

import * as fs from 'fs'
import * as path from 'path'

function collectWdsFiles(dir: string): string[] {
    const results: string[] = []

    function walk(current: string) {
        const entries = fs.readdirSync(current, { withFileTypes: true })
        for (const entry of entries) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) {
                walk(full)
            } else if (entry.isFile() && entry.name.endsWith('.wds')) {
                results.push(full)
            }
        }
    }

    walk(dir)
    return results
}

function toFileTag(filePath: string, rootDir: string): string {
    const rel = path.relative(rootDir, filePath).replace(/\\/g, '/')
    return `[file://${rel}]`
}

function bundle(inputDir: string, outputFile: string) {
    const absInput = path.resolve(inputDir)
    const files = collectWdsFiles(absInput)

    if (files.length === 0) {
        console.error(`No .wds files found in: ${absInput}`)
        process.exit(1)
    }

    files.sort()

    const chunks: string[] = []

    for (const file of files) {
        const tag = toFileTag(file, absInput)
        const content = fs.readFileSync(file, 'utf8').trimEnd()
        chunks.push(`${tag}\n${content}`)
    }

    const output = chunks.join('\n\n') + '\n'
    fs.writeFileSync(outputFile, output, 'utf8')

    console.log(`Bundled ${files.length} file(s) → ${outputFile}`)
}

// ── CLI entry point ────────────────────────────────────────────────────────────

const [, , inputDir, outputFile] = process.argv

if (!inputDir || !outputFile) {
    console.error('Usage: bundle <input-directory> <output-file>')
    process.exit(1)
}

bundle(inputDir, outputFile)
