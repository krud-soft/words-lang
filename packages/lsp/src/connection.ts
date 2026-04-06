/**
 * connection.ts
 *
 * The WordsConnection class wires the WORDS parser library to the LSP
 * protocol. It handles the full lifecycle of the language server:
 *
 * - Initialisation: receives the workspace root from the client and loads
 *   the Workspace by scanning all .wds files.
 *
 * - Diagnostics: runs the Analyser on every file change and pushes
 *   diagnostics to the client for display in the editor.
 *
 * - Go-to-definition: resolves a cursor position to a construct name and
 *   returns the file path and range of its definition using the Workspace's
 *   constructPaths index.
 *
 * - Document sync: keeps the Workspace in sync as files are opened, changed,
 *   and saved. On save, the Workspace reloads the changed file and re-runs
 *   the analyser across the whole project.
 *
 * The connection never touches the filesystem directly — all file access
 * goes through the Workspace.
 */

import {
    Connection,
    TextDocuments,
    InitializeParams,
    InitializeResult,
    TextDocumentSyncKind,
    DefinitionParams,
    Location,
    Range,
    Position,
    PublishDiagnosticsParams,
    Diagnostic as LspDiagnostic,
    DiagnosticSeverity as LspDiagnosticSeverity,
} from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { Workspace, Analyser, Diagnostic, DiagnosticSeverity } from '@words-lang/parser'

export class WordsConnection {
    private connection: Connection
    private documents: TextDocuments<TextDocument>
    private workspace: Workspace | null = null
    private projectRoot: string | null = null

    constructor(connection: Connection) {
        this.connection = connection
        this.documents = new TextDocuments(TextDocument)
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    /**
     * Registers all LSP protocol handlers and starts listening.
     * Called once from server.ts after the connection is created.
     */
    listen(): void {
        this.connection.onInitialize(params => this.onInitialize(params))
        this.connection.onInitialized(() => this.onInitialized())
        this.connection.onDefinition(params => this.onDefinition(params))

        this.documents.onDidSave(event => this.onDidSave(event.document))
        this.documents.onDidOpen(event => this.onDidSave(event.document))

        this.documents.listen(this.connection)
        this.connection.listen()
    }

    // ── Initialize ─────────────────────────────────────────────────────────────

    /**
     * Handles the LSP initialize request.
     * Receives the workspace root URI and declares server capabilities.
     */
    private onInitialize(params: InitializeParams): InitializeResult {
        if (params.rootUri) {
            this.projectRoot = uriToPath(params.rootUri)
        } else if (params.rootPath) {
            this.projectRoot = params.rootPath
        }

        return {
            capabilities: {
                textDocumentSync: TextDocumentSyncKind.Incremental,
                definitionProvider: true,
            },
        }
    }

    /**
     * Handles the LSP initialized notification.
     * The client has confirmed initialization — load the workspace and
     * run the first analysis pass.
     */
    private onInitialized(): void {
        if (!this.projectRoot) return
        this.reloadWorkspace()
    }

    // ── Document events ────────────────────────────────────────────────────────

    /**
     * Handles file open and save events.
     * Reloads the changed file in the workspace and re-runs the analyser
     * across the whole project, then pushes updated diagnostics.
     */
    private onDidSave(document: TextDocument): void {
        if (!this.workspace) {
            this.reloadWorkspace()
            return
        }

        const filePath = uriToPath(document.uri)
        if (filePath.endsWith('.wds')) {
            this.workspace.reload(filePath)
            this.publishDiagnostics()
        }
    }

    // ── Go-to-definition ───────────────────────────────────────────────────────

    /**
     * Handles a go-to-definition request from the client.
     *
     * Resolves the word under the cursor to a construct name, then looks it
     * up in the workspace's constructPaths index. If found, returns the
     * file path and the start of the file as the definition location.
     *
     * The range points to line 0 for now — a future improvement would parse
     * the target file and find the exact token position of the construct
     * declaration.
     */
    private onDefinition(params: DefinitionParams): Location | Location[] | null {
        if (!this.workspace) return null

        const document = this.documents.get(params.textDocument.uri)
        if (!document) return null

        const word = this.getWordAtPosition(document, params.position)
        if (!word) return null

        // `state` inside a component file → show all states that use this component
        if (word === 'state') {
            const filePath = uriToPath(params.textDocument.uri)
            const states = this.resolveStatesUsingComponent(filePath)
            if (states.length > 0) return states
        }

        return this.resolveDefinition(word)
    }

    // ── Diagnostics ────────────────────────────────────────────────────────────

    /**
     * Runs the analyser and pushes all diagnostics to the client.
     * Clears diagnostics for files that no longer have any errors.
     */
    private publishDiagnostics(): void {
        if (!this.workspace) return

        // Collect all diagnostics by file path
        const byFile = new Map<string, LspDiagnostic[]>()

        // Parse diagnostics
        for (const { filePath, diagnostic } of this.workspace.allParseDiagnostics()) {
            if (!byFile.has(filePath)) byFile.set(filePath, [])
            byFile.get(filePath)!.push(toLspDiagnostic(diagnostic))
        }

        // Semantic diagnostics from the analyser
        const { diagnostics } = new Analyser(this.workspace).analyse()
        for (const { filePath, diagnostic } of diagnostics) {
            if (!byFile.has(filePath)) byFile.set(filePath, [])
            byFile.get(filePath)!.push(toLspDiagnostic(diagnostic))
        }

        // Push diagnostics for all files that have them
        for (const [filePath, diags] of byFile) {
            this.connection.sendDiagnostics({
                uri: pathToUri(filePath),
                diagnostics: diags,
            } as PublishDiagnosticsParams)
        }

        // Clear diagnostics for files that previously had errors but now don't
        for (const [filePath] of this.workspace.files) {
            if (!byFile.has(filePath)) {
                this.connection.sendDiagnostics({
                    uri: pathToUri(filePath),
                    diagnostics: [],
                } as PublishDiagnosticsParams)
            }
        }
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /**
     * Loads or reloads the entire workspace from the project root.
     */
    private reloadWorkspace(): void {
        if (!this.projectRoot) return
        this.workspace = Workspace.load(this.projectRoot)
        this.publishDiagnostics()
    }

    /**
     * Extracts the word (identifier) at the given position in a document.
     * Used to determine what the user's cursor is on for go-to-definition.
     */
    private getWordAtPosition(document: TextDocument, position: Position): string | null {
        const text = document.getText()
        const offset = document.offsetAt(position)

        // Walk left to find the start of the word
        let start = offset
        while (start > 0 && isIdentChar(text[start - 1])) {
            start--
        }

        // Walk right to find the end of the word
        let end = offset
        while (end < text.length && isIdentChar(text[end])) {
            end++
        }

        // Also check for a dot before the word to capture the module prefix
        let qualifiedStart = start
        if (start > 0 && text[start - 1] === '.') {
            // Walk further left past the module name
            qualifiedStart = start - 1
            while (qualifiedStart > 0 && isIdentChar(text[qualifiedStart - 1])) {
                qualifiedStart--
            }
        }

        const word = text.slice(qualifiedStart, end).replace(/^\./, '')
        return word.length > 0 ? word : null
    }

    /**
     * Resolves a word to a definition Location using the workspace index.
     *
     * Handles three forms:
     *   - `Module.Construct`  — looks up by module and construct name
     *   - `ConstructName`     — searches all modules for a matching construct
     *   - `ModuleName`        — returns the module definition file
     */
    private resolveDefinition(word: string): Location | null {
        if (!this.workspace) return null

        const dotIndex = word.indexOf('.')
        if (dotIndex !== -1) {
            const left = word.slice(0, dotIndex)
            const right = word.slice(dotIndex + 1)

            // system.ModuleName → navigate to the module definition
            if (left === 'system') {
                const modulePath = this.workspace.modulePaths.get(right)
                if (modulePath) return fileLocation(modulePath)
            }

            // ModuleName.methodName → search module inline interfaces for that method
            const methodLoc = this.resolveModuleMethod(left, right)
            if (methodLoc) return methodLoc

            // ModuleName.Construct → construct in that module
            const key = `${left}/${right}`
            const filePath = this.workspace.constructPaths.get(key)
            if (filePath) return fileLocation(filePath)
        }

        // Try as a module name
        const modulePath = this.workspace.modulePaths.get(word)
        if (modulePath) return fileLocation(modulePath)

        // Try as a construct name across all modules
        for (const [key, filePath] of this.workspace.constructPaths) {
            if (key.split('/')[1] === word) {
                return fileLocation(filePath)
            }
        }

        // Try as a camelCase name — prop name, handler arg, method name, or method parameter
        if (/^[a-z]/.test(word)) {
            const byPropName = this.resolveViewPropByName(word)
            if (byPropName) return byPropName

            const byArgName = this.resolveHandlerArg(word)
            if (byArgName) return byArgName

            const byMethodName = this.resolveModuleMethodByName(word)
            if (byMethodName) return byMethodName

            const byMethodParam = this.resolveModuleMethodParam(word)
            if (byMethodParam) return byMethodParam
        }

        return null
    }

    /**
     * Searches all module inline interfaces for a method by name.
     * Used when the cursor is on a bare method name like `switch`.
     */
    private resolveModuleMethodByName(methodName: string): Location | null {
        if (!this.workspace) return null

        for (const [moduleName, moduleNode] of this.workspace.modules) {
            const modulePath = this.workspace.modulePaths.get(moduleName)
            if (!modulePath) continue

            for (const iface of moduleNode.inlineInterfaces) {
                for (const method of iface.methods) {
                    if (method.name === methodName) {
                        return tokenLocation(modulePath, method.token)
                    }
                }
            }
        }

        return null
    }

    /**
     * Searches a module's inline interfaces for a method named `methodName`.
     * Navigates to the method's token.
     * Used for `ModuleName.methodName` (e.g. `RoutingModule.subscribeRoute`).
     */
    private resolveModuleMethod(moduleName: string, methodName: string): Location | null {
        if (!this.workspace) return null

        const moduleNode = this.workspace.modules.get(moduleName)
        if (!moduleNode) return null

        const modulePath = this.workspace.modulePaths.get(moduleName)
        if (!modulePath) return null

        for (const iface of moduleNode.inlineInterfaces) {
            for (const method of iface.methods) {
                if (method.name === methodName) {
                    return tokenLocation(modulePath, method.token)
                }
            }
        }

        return null
    }

    /**
     * Searches all module inline interface methods for a parameter named `paramName`.
     * Navigates to the param's token.
     * Used when the cursor is on e.g. `path` in `subscribeRoute path is "..."`.
     */
    private resolveModuleMethodParam(paramName: string): Location | null {
        if (!this.workspace) return null

        for (const [moduleName, moduleNode] of this.workspace.modules) {
            const modulePath = this.workspace.modulePaths.get(moduleName)
            if (!modulePath) continue

            for (const iface of moduleNode.inlineInterfaces) {
                for (const method of iface.methods) {
                    for (const param of method.params) {
                        if (param.name === paramName) {
                            return tokenLocation(modulePath, param.token)
                        }
                    }
                }
            }
        }

        return null
    }

    /**
     * Searches all components with props (views, providers, adapters, interfaces)
     * for a prop whose `name` matches — navigates to the prop token.
     */
    private resolveViewPropByName(propName: string): Location | null {
        return this.searchComponentProps((prop, filePath) =>
            prop.name === propName ? tokenLocation(filePath, prop.token) : null
        )
    }

    /**
     * Searches all components with props for a prop whose `argName` matches —
     * navigates to the argName token specifically.
     */
    private resolveHandlerArg(argName: string): Location | null {
        return this.searchComponentProps((prop, filePath) =>
            prop.argName === argName && prop.argNameToken
                ? tokenLocation(filePath, prop.argNameToken!)
                : null
        )
    }

    /**
     * Iterates props across views, providers, adapters, and interfaces.
     * Calls `predicate` for each prop; returns the first non-null result.
     */
    private searchComponentProps(
        predicate: (prop: { name: string; argName: string | null; argNameToken: { line: number; column: number; value: string } | null; token: { line: number; column: number; value: string } }, filePath: string) => Location | null
    ): Location | null {
        if (!this.workspace) return null

        const componentMaps = [
            this.workspace.views,
            this.workspace.providers,
            this.workspace.adapters,
            this.workspace.interfaces,
        ]

        for (const moduleIndex of componentMaps) {
            for (const [moduleName, componentMap] of moduleIndex) {
                for (const [componentName, componentNode] of componentMap) {
                    const filePath = this.workspace.constructPaths.get(`${moduleName}/${componentName}`)
                    if (!filePath) continue
                    for (const prop of (componentNode as any).props as any[]) {
                        const result = predicate(prop, filePath)
                        if (result) return result
                    }
                }
            }
        }

        return null
    }

    /**
     * Given a component file path, finds all states that `uses` that component
     * (by screen, view, adapter, provider, or interface name) and returns one
     * Location per state, pointing to the state's token.
     */
    private resolveStatesUsingComponent(componentFilePath: string): Location[] {
        if (!this.workspace) return []

        // Reverse-look up: which module/name owns this file path?
        let componentName: string | null = null
        for (const [key, fp] of this.workspace.constructPaths) {
            if (fp === componentFilePath) {
                componentName = key.split('/')[1]
                break
            }
        }
        if (!componentName) return []

        const locations: Location[] = []

        for (const [moduleName, stateMap] of this.workspace.states) {
            for (const [stateName, stateNode] of stateMap) {
                if (this.stateUsesComponent(stateNode, componentName)) {
                    const filePath = this.workspace.constructPaths.get(`${moduleName}/${stateName}`)
                    if (filePath) locations.push(tokenLocation(filePath, stateNode.token))
                }
            }
        }

        return locations
    }

    /**
     * Returns true if any entry in the state's `uses` tree references `componentName`.
     */
    private stateUsesComponent(stateNode: { uses: any[] }, componentName: string): boolean {
        const checkEntries = (entries: any[]): boolean => {
            for (const entry of entries) {
                if (entry.kind === 'ComponentUse') {
                    const parts: string[] = entry.name.parts
                    if (parts[parts.length - 1] === componentName) return true
                    if (checkEntries(entry.uses)) return true
                } else if (entry.kind === 'ConditionalBlock' || entry.kind === 'IterationBlock') {
                    if (checkEntries(entry.body)) return true
                }
            }
            return false
        }
        return checkEntries(stateNode.uses)
    }
}

// ── Utilities ──────────────────────────────────────────────────────────────────

/**
 * Converts a file:// URI to a filesystem path.
 */
function uriToPath(uri: string): string {
    // Strip "file://" — leaves "/Users/..." on Mac/Linux, "/C:/..." on Windows
    let path = decodeURIComponent(uri.replace(/^file:\/\//, ''))
    // On Windows: /C:/Users/... → C:/Users/...
    path = path.replace(/^\/([A-Za-z]:)/, '$1')
    // Normalize to OS separator
    return path.replace(/\//g, require('path').sep)
}

/**
 * Converts a filesystem path to a file:// URI.
 */
function pathToUri(filePath: string): string {
    // Normalize to forward slashes
    const normalized = filePath.replace(/\\/g, '/')
    // Windows: C:/... → /C:/...
    return normalized.match(/^[A-Za-z]:/)
        ? `file:///${normalized}`
        : `file://${normalized}`
}

/**
 * Returns an LSP Location pointing to the exact position of a token.
 * Token line and column are 1-based; LSP positions are 0-based.
 */
function tokenLocation(filePath: string, token: { line: number; column: number; value: string }): Location {
    const line = token.line - 1
    const char = token.column - 1
    return {
        uri: pathToUri(filePath),
        range: Range.create(
            Position.create(line, char),
            Position.create(line, char + token.value.length)
        ),
    }
}

/**
 * Returns an LSP Location pointing to the start of a file.
 * Used when the exact token position within the file is not yet resolved.
 */
function fileLocation(filePath: string): Location {
    return {
        uri: pathToUri(filePath),
        range: Range.create(Position.create(0, 0), Position.create(0, 0)),
    }
}

/**
 * Returns true if the character is valid inside a WORDS identifier.
 */
function isIdentChar(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch)
}

/**
 * Converts a WORDS parser Diagnostic to an LSP Diagnostic.
 */
function toLspDiagnostic(diagnostic: Diagnostic): LspDiagnostic {
    return {
        range: Range.create(
            Position.create(diagnostic.range.start.line, diagnostic.range.start.character),
            Position.create(diagnostic.range.end.line, diagnostic.range.end.character)
        ),
        severity: toLspSeverity(diagnostic.severity),
        code: diagnostic.code,
        source: `words-${diagnostic.source}`,
        message: diagnostic.message,
    }
}

/**
 * Maps a WORDS DiagnosticSeverity to an LSP DiagnosticSeverity.
 */
function toLspSeverity(severity: DiagnosticSeverity): LspDiagnosticSeverity {
    switch (severity) {
        case 'error': return LspDiagnosticSeverity.Error
        case 'warning': return LspDiagnosticSeverity.Warning
        case 'hint': return LspDiagnosticSeverity.Hint
    }
}
