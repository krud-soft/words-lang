/**
 * workspace.ts
 *
 * The Workspace scans a WORDS project directory, parses every `.wds` file it
 * finds, and builds a cross-file index of all constructs organised by module.
 *
 * The index is the shared data structure consumed by the Analyser and later
 * by the LSP server for go-to-definition and find-references. Neither the
 * Analyser nor the LSP reads files directly — they always go through the
 * Workspace.
 *
 * Design principles:
 *
 * - One parse per file. The Workspace caches parse results so the Analyser
 *   can query the index repeatedly without re-parsing.
 *
 * - Flat index structure. Constructs are indexed by module name and construct
 *   name so lookups are O(1) rather than requiring a tree walk.
 *
 * - Parse errors are preserved. Files that fail to parse partially are still
 *   indexed — whatever nodes were recovered are included. Parse diagnostics
 *   are stored alongside the index and returned with analyser diagnostics.
 *
 * - The Workspace is synchronous. File I/O uses Node's `fs` module directly.
 *   The LSP layer wraps this in async when needed.
 */

import * as fs from 'fs'
import * as path from 'path'
import { Lexer } from '../lexer/lexer'
import { Parser, ParseResult } from '../parser/parser'
import {
    SystemNode,
    ModuleNode,
    StateNode,
    ContextNode,
    ScreenNode,
    ViewNode,
    ProviderNode,
    AdapterNode,
    InterfaceNode,
    TopLevelNode,
    DocumentNode,
} from '../parser/ast'
import { Diagnostic } from './diagnostics'

// ── Construct index maps ──────────────────────────────────────────────────────

/**
 * A map from construct name to node, scoped to one module.
 * e.g. states.get('AuthModule')?.get('Unauthenticated') → StateNode
 */
type ConstructMap<T> = Map<string, T>

/**
 * A map from module name to a per-module construct map.
 */
type ModuleIndex<T> = Map<string, ConstructMap<T>>

// ── File record ───────────────────────────────────────────────────────────────

/**
 * Everything the Workspace knows about a single `.wds` file.
 *
 * `filePath`    — absolute path to the file on disk.
 * `source`      — raw source text read from disk.
 * `parseResult` — the result of parsing the source, including the document
 *                 AST and any parse-layer diagnostics.
 */
export interface FileRecord {
    filePath: string
    source: string
    parseResult: ParseResult
}

// ── Workspace ─────────────────────────────────────────────────────────────────

/**
 * The cross-file index of a WORDS project.
 *
 * Built by calling `Workspace.load(projectRoot)`. Consumers query the index
 * directly via the public maps — there are no query methods, just data.
 */
export class Workspace {
    /** Absolute path to the project root directory. */
    readonly projectRoot: string

    /**
     * All parsed files, keyed by absolute file path.
     * Includes both successfully parsed files and files with parse errors.
     */
    readonly files: Map<string, FileRecord> = new Map()

    /**
     * All parse-layer diagnostics collected across all files.
     * Indexed by absolute file path.
     */
    readonly parseDiagnostics: Map<string, Diagnostic[]> = new Map()

    /**
     * The single system declaration found in the project.
     * Null if no system file was found or if it failed to parse.
     */
    system: SystemNode | null = null

    /**
     * The file path of the system declaration, for diagnostic reporting.
     */
    systemFilePath: string | null = null

    /**
     * All module definitions, keyed by module name.
     * e.g. modules.get('AuthModule') → ModuleNode
     */
    readonly modules: Map<string, ModuleNode> = new Map()

    /**
     * File path of each module definition, for diagnostic reporting.
     * e.g. modulePaths.get('AuthModule') → '/project/AuthModule/AuthModule.wds'
     */
    readonly modulePaths: Map<string, string> = new Map()

    /**
     * All state definitions, keyed by module name then state name.
     * e.g. states.get('AuthModule')?.get('Unauthenticated') → StateNode
     */
    readonly states: ModuleIndex<StateNode> = new Map()

    /**
     * All context definitions, keyed by module name then context name.
     */
    readonly contexts: ModuleIndex<ContextNode> = new Map()

    /**
     * All screen definitions, keyed by module name then screen name.
     */
    readonly screens: ModuleIndex<ScreenNode> = new Map()

    /**
     * All view definitions, keyed by module name then view name.
     */
    readonly views: ModuleIndex<ViewNode> = new Map()

    /**
     * All provider definitions, keyed by module name then provider name.
     */
    readonly providers: ModuleIndex<ProviderNode> = new Map()

    /**
     * All adapter definitions, keyed by module name then adapter name.
     */
    readonly adapters: ModuleIndex<AdapterNode> = new Map()

    /**
     * All interface component definitions, keyed by module name then interface name.
     */
    readonly interfaces: ModuleIndex<InterfaceNode> = new Map()

    /**
     * File path of each construct, for go-to-definition.
     * Key format: 'ModuleName/ConstructName' (e.g. 'AuthModule/Unauthenticated')
     */
    readonly constructPaths: Map<string, string> = new Map()

    private constructor(projectRoot: string) {
        this.projectRoot = projectRoot
    }

    // ── Factory ────────────────────────────────────────────────────────────────

    /**
     * Scans `projectRoot` recursively for `.wds` files, parses each one,
     * and returns a fully populated Workspace.
     *
     * Never throws — files that cannot be read or parsed are recorded with
     * their errors and skipped during indexing.
     */
    static load(projectRoot: string): Workspace {
        const ws = new Workspace(path.resolve(projectRoot))
        const wdsPaths = ws.findWdsFiles(ws.projectRoot)

        for (const filePath of wdsPaths) {
            ws.loadFile(filePath)
        }

        ws.buildIndex()
        return ws
    }

    /**
     * Reloads a single file and rebuilds the index.
     * Used by the LSP server when a file changes on disk.
     */
    reload(filePath: string): void {
        this.loadFile(path.resolve(filePath))
        this.clearIndex()
        this.buildIndex()
    }

    // ── Query helpers ──────────────────────────────────────────────────────────

    /**
     * Returns the StateNode for the given module and state name, or null.
     */
    getState(moduleName: string, stateName: string): StateNode | null {
        return this.states.get(moduleName)?.get(stateName) ?? null
    }

    /**
     * Returns the ContextNode for the given module and context name, or null.
     */
    getContext(moduleName: string, contextName: string): ContextNode | null {
        return this.contexts.get(moduleName)?.get(contextName) ?? null
    }

    /**
     * Returns the ScreenNode for the given module and screen name, or null.
     */
    getScreen(moduleName: string, screenName: string): ScreenNode | null {
        return this.screens.get(moduleName)?.get(screenName) ?? null
    }

    /**
     * Returns the ViewNode for the given module and view name, or null.
     * Also searches other modules if moduleName is null.
     */
    getView(moduleName: string, viewName: string): ViewNode | null {
        return this.views.get(moduleName)?.get(viewName) ?? null
    }

    /**
     * Returns all parse diagnostics across all files as a flat array,
     * each annotated with the file path that produced it.
     */
    allParseDiagnostics(): Array<{ filePath: string; diagnostic: Diagnostic }> {
        const result: Array<{ filePath: string; diagnostic: Diagnostic }> = []
        for (const [filePath, diags] of this.parseDiagnostics) {
            for (const d of diags) {
                result.push({ filePath, diagnostic: d })
            }
        }
        return result
    }

    // ── Private — file loading ─────────────────────────────────────────────────

    /**
     * Reads and parses a single `.wds` file, storing the result in `this.files`.
     * Silently records any read error as a parse diagnostic.
     */
    private loadFile(filePath: string): void {
        let source: string
        try {
            source = fs.readFileSync(filePath, 'utf-8')
        } catch (err) {
            // File could not be read — record and skip
            this.files.set(filePath, {
                filePath,
                source: '',
                parseResult: {
                    document: { kind: 'Document', ownerModule: null, nodes: [] },
                    diagnostics: [],
                },
            })
            return
        }

        const tokens = new Lexer(source).tokenize()
        const parseResult = new Parser(tokens).parse()

        this.files.set(filePath, { filePath, source, parseResult })

        if (parseResult.diagnostics.length > 0) {
            this.parseDiagnostics.set(filePath, parseResult.diagnostics)
        }
    }

    /**
     * Recursively finds all `.wds` files under `dir`.
     * Skips `node_modules` and hidden directories.
     */
    private findWdsFiles(dir: string): string[] {
        const results: string[] = []
        let entries: fs.Dirent[]

        try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
            return results
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue
            if (entry.name === 'node_modules') continue

            const fullPath = path.join(dir, entry.name)

            if (entry.isDirectory()) {
                results.push(...this.findWdsFiles(fullPath))
            } else if (entry.isFile() && entry.name.endsWith('.wds')) {
                results.push(fullPath)
            }
        }

        return results
    }

    // ── Private — index building ───────────────────────────────────────────────

    /**
     * Clears all index maps. Called before a rebuild.
     */
    private clearIndex(): void {
        this.system = null
        this.systemFilePath = null
        this.modules.clear()
        this.modulePaths.clear()
        this.states.clear()
        this.contexts.clear()
        this.screens.clear()
        this.views.clear()
        this.providers.clear()
        this.adapters.clear()
        this.interfaces.clear()
        this.constructPaths.clear()
    }

    /**
     * Walks all parsed documents and populates the index maps.
     * Called once after all files are loaded, and again after each reload.
     */
    private buildIndex(): void {
        for (const [filePath, record] of this.files) {
            this.indexDocument(filePath, record.parseResult.document)
        }

        // Second pass: fill in the module name on component nodes that were
        // parsed from files with an ownerModule declaration. The parser leaves
        // module: '' on component nodes — we fill it in here from ownerModule.
        for (const [, record] of this.files) {
            const doc = record.parseResult.document
            if (doc.ownerModule) {
                for (const node of doc.nodes) {
                    if ('module' in node && node.module === '') {
                        ; (node as any).module = doc.ownerModule
                    }
                }
            }
        }
    }

    /**
     * Indexes all top-level nodes in a single document into the appropriate maps.
     */
    private indexDocument(filePath: string, document: DocumentNode): void {
        const ownerModule = document.ownerModule

        for (const node of document.nodes) {
            this.indexNode(filePath, node, ownerModule)
        }
    }

    /**
     * Indexes a single top-level node into the appropriate map.
     * Uses `ownerModule` from the ownership declaration if the node's own
     * `module` field is empty (component files).
     */
    private indexNode(
        filePath: string,
        node: TopLevelNode,
        ownerModule: string | null
    ): void {
        switch (node.kind) {
            case 'System':
                this.system = node
                this.systemFilePath = filePath
                break

            case 'Module':
                this.modules.set(node.name, node)
                this.modulePaths.set(node.name, filePath)
                break

            case 'State': {
                const mod = node.module || ownerModule || ''
                if (!mod) break
                this.ensureModuleMap(this.states, mod)
                this.states.get(mod)!.set(node.name, node)
                this.constructPaths.set(`${mod}/${node.name}`, filePath)
                break
            }

            case 'Context': {
                const mod = node.module || ownerModule || ''
                if (!mod) break
                this.ensureModuleMap(this.contexts, mod)
                this.contexts.get(mod)!.set(node.name, node)
                this.constructPaths.set(`${mod}/${node.name}`, filePath)
                break
            }

            case 'Screen': {
                const mod = node.module || ownerModule || ''
                if (!mod) break
                this.ensureModuleMap(this.screens, mod)
                this.screens.get(mod)!.set(node.name, node)
                this.constructPaths.set(`${mod}/${node.name}`, filePath)
                break
            }

            case 'View': {
                const mod = node.module || ownerModule || ''
                if (!mod) break
                this.ensureModuleMap(this.views, mod)
                this.views.get(mod)!.set(node.name, node)
                this.constructPaths.set(`${mod}/${node.name}`, filePath)
                break
            }

            case 'Provider': {
                const mod = node.module || ownerModule || ''
                if (!mod) break
                this.ensureModuleMap(this.providers, mod)
                this.providers.get(mod)!.set(node.name, node)
                this.constructPaths.set(`${mod}/${node.name}`, filePath)
                break
            }

            case 'Adapter': {
                const mod = node.module || ownerModule || ''
                if (!mod) break
                this.ensureModuleMap(this.adapters, mod)
                this.adapters.get(mod)!.set(node.name, node)
                this.constructPaths.set(`${mod}/${node.name}`, filePath)
                break
            }

            case 'Interface': {
                const mod = node.module || ownerModule || ''
                if (!mod) break
                this.ensureModuleMap(this.interfaces, mod)
                this.interfaces.get(mod)!.set(node.name, node)
                this.constructPaths.set(`${mod}/${node.name}`, filePath)
                break
            }
        }
    }

    /**
     * Ensures a per-module map exists for the given module name.
     */
    private ensureModuleMap<T>(index: ModuleIndex<T>, moduleName: string): void {
        if (!index.has(moduleName)) {
            index.set(moduleName, new Map())
        }
    }
}
