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
    CompletionItem,
    CompletionItemKind,
    CompletionParams,
    Location,
    Range,
    Position,
    PublishDiagnosticsParams,
    Diagnostic as LspDiagnostic,
    DiagnosticSeverity as LspDiagnosticSeverity,
} from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { Workspace, Analyser, Diagnostic, DiagnosticSeverity } from '@words-lang/parser'

type ComponentCompletionKind = 'screen' | 'view' | 'provider' | 'adapter' | 'interface'
type WordsCompletionContext =
    | { kind: ComponentCompletionKind }
    | { kind: 'componentKeyword' | 'context' | 'state' }
    | { kind: 'adapterMethod'; adapterName: string }

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
        this.connection.onCompletion(params => this.onCompletion(params))

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
                completionProvider: {
                    triggerCharacters: [' ', '.', '('],
                },
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

        const currentFilePath = uriToPath(params.textDocument.uri)
        const currentModuleName = this.resolveCurrentModuleName(currentFilePath, document)

        const adapterArgLoc = this.resolveAdapterArgumentAtPosition(document, params.position, word, currentModuleName)
        if (adapterArgLoc) return adapterArgLoc

        const systemContextFieldLoc = this.resolveSystemGetContextFieldAtPosition(document, params.position, word, currentModuleName)
        if (systemContextFieldLoc) return systemContextFieldLoc

        // Construct name in its own file → show constructs that consume/use it.
        const constructConsumers = this.resolveConsumersForConstructName(currentFilePath, word)
        if (constructConsumers.length > 0) return constructConsumers

        // `state` inside a component file → show all states that use this component
        if (word === 'state') {
            const states = this.resolveStatesUsingComponent(currentFilePath)
            if (states.length > 0) return states
        }

        // Field name inside a props.propName(...) call → navigate to the context field
        if (/^[a-z]/.test(word)) {
            const propName = getPropCallPropName(document, params.position)
            if (propName) {
                const loc = this.resolveContextFieldInPropCall(word, propName, currentFilePath)
                if (loc) return loc
            }
        }

        // Method name in a module inline interface → show implementors (named interface)
        // or callers (anonymous interface)
        if (/^[a-z]/.test(word)) {
            const refs = this.resolveInterfaceMethodReferences(word)
            if (refs && refs.length > 0) return refs
        }

        return this.resolveDefinition(word, currentFilePath)
    }

    // ── Completion ────────────────────────────────────────────────────────────

    private onCompletion(params: CompletionParams): CompletionItem[] {
        if (!this.workspace) return []

        const document = this.documents.get(params.textDocument.uri)
        if (!document) return []

        const currentFilePath = uriToPath(params.textDocument.uri)
        const currentModuleName = this.resolveCurrentModuleName(currentFilePath, document)
        const context = this.detectCompletionContext(document, params.position)

        if (!context) return []

        switch (context.kind) {
            case 'componentKeyword':
                return this.componentUseKeywordCompletions()
            case 'screen':
                return this.constructCompletionItems(this.workspace.screens, currentModuleName, 'screen', CompletionItemKind.Class)
            case 'view':
                return this.constructCompletionItems(this.workspace.views, currentModuleName, 'view', CompletionItemKind.Class)
            case 'provider':
                return this.constructCompletionItems(this.workspace.providers, currentModuleName, 'provider', CompletionItemKind.Class)
            case 'adapter':
                return this.constructCompletionItems(this.workspace.adapters, currentModuleName, 'adapter', CompletionItemKind.Class)
            case 'interface':
                return this.constructCompletionItems(this.workspace.interfaces, currentModuleName, 'interface', CompletionItemKind.Interface)
            case 'context':
                return this.constructCompletionItems(this.workspace.contexts, currentModuleName, 'context', CompletionItemKind.Struct)
            case 'state':
                return this.constructCompletionItems(this.workspace.states, currentModuleName, 'state', CompletionItemKind.Class)
            case 'adapterMethod':
                return this.adapterMethodCompletionItems(context.adapterName, currentModuleName)
        }
    }

    private detectCompletionContext(document: TextDocument, position: Position): WordsCompletionContext | null {
        const linePrefix = document.getText(Range.create(Position.create(position.line, 0), position))

        if (/\breceives\s+\??[A-Za-z0-9_]*$/.test(linePrefix)) return { kind: 'context' }
        if (/\breturns\s+(?:\(\s*)?[A-Za-z0-9_]*$/.test(linePrefix)) return { kind: 'context' }
        if (/\bstate\.return(?:\s+|\(\s*)[A-Za-z0-9_]*$/.test(linePrefix)) return { kind: 'context' }
        if (/\bsystem\.getContext\(\s*[A-Za-z0-9_]*$/.test(linePrefix)) return { kind: 'context' }
        if (/\bwhen\s+[A-Za-z0-9_]*$/.test(linePrefix)) return { kind: 'state' }
        if (/\benter\s+[A-Za-z0-9_]*$/.test(linePrefix)) return { kind: 'state' }
        if (/\bstart\s+[A-Za-z0-9_]*$/.test(linePrefix)) return { kind: 'state' }

        const usesBlock = this.isInsideUsesBlock(document, position)
        const adapterMethodMatch = linePrefix.match(/(?:^|[\s,(])adapter\s+([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?)\.[A-Za-z0-9_]*$/)
        if (adapterMethodMatch && (usesBlock || /\buses\s+/.test(linePrefix))) {
            return { kind: 'adapterMethod', adapterName: adapterMethodMatch[1] }
        }

        const useKindMatch = linePrefix.match(/(?:^|[\s,(])(?:uses\s+)?(screen|view|provider|adapter|interface)\s+[A-Za-z0-9_.]*$/)
        if (useKindMatch && (usesBlock || /\buses\s+/.test(linePrefix))) {
            return { kind: useKindMatch[1] as ComponentCompletionKind }
        }

        if (/\buses\s+[A-Za-z]*$/.test(linePrefix)) return { kind: 'componentKeyword' }
        if (usesBlock && /^\s*(?:,\s*)?[A-Za-z]*$/.test(linePrefix)) return { kind: 'componentKeyword' }

        return null
    }

    private isInsideUsesBlock(document: TextDocument, position: Position): boolean {
        const before = document.getText(Range.create(Position.create(0, 0), position))
        const matches = [...before.matchAll(/\buses\s*\(/g)]
        const lastMatch = matches[matches.length - 1]
        if (!lastMatch || lastMatch.index === undefined) return false

        const openParen = lastMatch.index + lastMatch[0].lastIndexOf('(')
        let depth = 0
        for (let i = openParen; i < before.length; i++) {
            if (before[i] === '(') depth++
            if (before[i] === ')') depth--
        }

        return depth > 0
    }

    private resolveCurrentModuleName(filePath: string, document: TextDocument): string | null {
        const target = this.resolveConstructByFilePath(filePath)
        if (target) return target.moduleName

        const ownerMatch = document.getText().match(/^\s*module\s+([A-Z][A-Za-z0-9_]*)/m)
        return ownerMatch?.[1] ?? null
    }

    private componentUseKeywordCompletions(): CompletionItem[] {
        return [
            { label: 'screen', kind: CompletionItemKind.Keyword, detail: 'state UI root' },
            { label: 'view', kind: CompletionItemKind.Keyword, detail: 'rendering component' },
            { label: 'provider', kind: CompletionItemKind.Keyword, detail: 'derived data component' },
            { label: 'adapter', kind: CompletionItemKind.Keyword, detail: 'I/O component' },
            { label: 'interface', kind: CompletionItemKind.Keyword, detail: 'contract component' },
        ]
    }

    private constructCompletionItems<T extends { name: string }>(
        moduleIndex: Map<string, Map<string, T>>,
        currentModuleName: string | null,
        detail: string,
        kind: CompletionItemKind
    ): CompletionItem[] {
        const items: CompletionItem[] = []
        const seen = new Set<string>()

        const addItem = (moduleName: string, name: string, qualified: boolean): void => {
            const label = qualified ? `${moduleName}.${name}` : name
            if (seen.has(label)) return
            seen.add(label)
            items.push({
                label,
                kind,
                detail: qualified ? `${detail} in ${moduleName}` : detail,
                insertText: label,
                sortText: qualified ? `1_${label}` : `0_${label}`,
            })
        }

        if (currentModuleName) {
            const localMap = moduleIndex.get(currentModuleName)
            if (localMap) {
                for (const name of localMap.keys()) addItem(currentModuleName, name, false)
            }
        }

        for (const [moduleName, constructMap] of moduleIndex) {
            if (moduleName === currentModuleName) continue
            for (const name of constructMap.keys()) addItem(moduleName, name, true)
        }

        return items
    }

    private adapterMethodCompletionItems(adapterName: string, currentModuleName: string | null): CompletionItem[] {
        if (!this.workspace) return []

        const parts = adapterName.split('.')
        const moduleName = parts.length === 1 ? currentModuleName : parts[0]
        const name = parts[parts.length - 1]
        if (!moduleName) return []

        const adapter = this.workspace.adapters.get(moduleName)?.get(name)
        if (!adapter) return []

        return adapter.methods.map(method => ({
            label: method.name,
            kind: CompletionItemKind.Method,
            detail: `method on ${name}`,
            insertText: method.name,
        }))
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
    private resolveDefinition(word: string, currentFilePath?: string): Location | null {
        if (!this.workspace) return null

        // Bare `system` keyword → navigate to the system definition file
        if (word === 'system' && this.workspace.systemFilePath) {
            return fileLocation(this.workspace.systemFilePath)
        }

        const dotIndex = word.indexOf('.')
        if (dotIndex !== -1) {
            const left = word.slice(0, dotIndex)
            const right = word.slice(dotIndex + 1)

            // system.ModuleName → navigate to the module definition
            if (left === 'system') {
                const systemMethodLoc = this.resolveSystemInterfaceMethod(right)
                if (systemMethodLoc) return systemMethodLoc

                const modulePath = this.workspace.modulePaths.get(right)
                if (modulePath) return fileLocation(modulePath)
            }

            // props.propName → navigate to the prop declaration on the enclosing component.
            // Search the current file first so self-referential props resolve locally.
            if (left === 'props') {
                if (currentFilePath) {
                    const local = this.resolveViewPropByName(right, currentFilePath)
                    if (local) return local
                }
                const byPropName = this.resolveViewPropByName(right)
                if (byPropName) return byPropName
            }

            // AdapterName.methodName → navigate to the method on the adapter
            const adapterMethodLoc = this.resolveAdapterMethod(left, right)
            if (adapterMethodLoc) return adapterMethodLoc

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

        // Try as a camelCase name. Resolution order matters — more specific wins:
        //   1. Method names on module inline interfaces (e.g. `switch`, `subscribeRoute`)
        //   2. Method parameters on module inline interfaces (e.g. `path` in `switch path(string)`)
        //   3. Handler argument names on component props (e.g. `backToDashboard`)
        //   4. Prop names on component props (e.g. `onSubmit`)
        if (/^[a-z]/.test(word)) {
            const byMethodName = this.resolveModuleMethodByName(word)
            if (byMethodName) return byMethodName

            const byMethodParam = this.resolveModuleMethodParam(word)
            if (byMethodParam) return byMethodParam

            const byArgName = this.resolveHandlerArg(word)
            if (byArgName) return byArgName

            const byPropName = this.resolveViewPropByName(word)
            if (byPropName) return byPropName
        }

        return null
    }

    private resolveAdapterArgumentAtPosition(
        document: TextDocument,
        position: Position,
        word: string,
        currentModuleName: string | null
    ): Location | null {
        if (!this.workspace || !/^[a-z]/.test(word)) return null

        const text = document.getText()
        const bounds = getIdentifierBounds(text, document.offsetAt(position))
        if (!bounds) return null

        const lineEnd = text.indexOf('\n', bounds.end)
        const afterWord = text.slice(bounds.end, lineEnd === -1 ? text.length : lineEnd)
        if (!/^\s+is\b|^\s*is\b/.test(afterWord)) return null

        const adapterUseName = getEnclosingAdapterUseName(text, bounds.start)
        if (!adapterUseName) return null

        return this.resolveAdapterMethodParam(adapterUseName, word, currentModuleName)
    }

    private resolveSystemGetContextFieldAtPosition(
        document: TextDocument,
        position: Position,
        word: string,
        currentModuleName: string | null
    ): Location | null {
        if (!/^[a-z]/.test(word)) return null

        const text = document.getText()
        const bounds = getIdentifierBounds(text, document.offsetAt(position))
        if (!bounds) return null

        const prefix = text.slice(0, bounds.start)
        const match = prefix.match(/\bsystem\.getContext\s*\(\s*([A-Z][A-Za-z0-9_]*)\s*\)\.\s*$/)
        if (!match) return null

        return this.resolveContextField(match[1], word, currentModuleName)
    }

    private resolveAdapterMethodParam(
        adapterUseName: string,
        paramName: string,
        currentModuleName: string | null
    ): Location | null {
        if (!this.workspace) return null

        const resolved = resolveAdapterUseName(adapterUseName, currentModuleName)
        if (!resolved) return null

        const candidates = resolved.moduleName
            ? [[resolved.moduleName, this.workspace.adapters.get(resolved.moduleName)] as const]
            : [...this.workspace.adapters.entries()]

        for (const [moduleName, adapterMap] of candidates) {
            const adapter = adapterMap?.get(resolved.adapterName)
            if (!adapter) continue

            const method = adapter.methods.find(m => m.name === resolved.methodName)
            const param = method?.params.find(p => p.name === paramName)
            if (!param) continue

            const filePath = this.workspace.constructPaths.get(`${moduleName}/${resolved.adapterName}`)
            if (filePath) return tokenLocation(filePath, param.token)
        }

        return null
    }

    private resolveSystemInterfaceMethod(methodName: string): Location | null {
        if (!this.workspace?.system || !this.workspace.systemFilePath) return null

        const method = this.workspace.system.interfaceMethods.find(m => m.name === methodName)
        return method ? tokenLocation(this.workspace.systemFilePath, method.token) : null
    }

    private resolveContextField(
        contextTypeName: string,
        fieldName: string,
        currentModuleName: string | null
    ): Location | null {
        if (!this.workspace) return null

        const ordered = [
            ...(currentModuleName ? [[currentModuleName, this.workspace.contexts.get(currentModuleName)] as const] : []),
            ...[...this.workspace.contexts.entries()].filter(([moduleName]) => moduleName !== currentModuleName),
        ]

        for (const [moduleName, contextMap] of ordered) {
            const contextNode = contextMap?.get(contextTypeName)
            if (!contextNode) continue

            const field = contextNode.fields.find(f => f.name === fieldName)
            if (!field) continue

            const filePath = this.workspace.constructPaths.get(`${moduleName}/${contextTypeName}`)
            if (filePath) return tokenLocation(filePath, field.token)
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
    private resolveAdapterMethod(adapterName: string, methodName: string): Location | null {
        if (!this.workspace) return null

        for (const [moduleName, adapterMap] of this.workspace.adapters) {
            const adapter = adapterMap.get(adapterName)
            if (!adapter) continue

            for (const method of adapter.methods) {
                if (method.name === methodName) {
                    const filePath = this.workspace.constructPaths.get(`${moduleName}/${adapterName}`)
                    if (filePath) return tokenLocation(filePath, method.token)
                }
            }
        }

        return null
    }

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
     * Resolves a field name inside a `props.propName(...)` call to the matching
     * field on the context type declared by that prop.
     *
     * Steps:
     *   1. Find the key (`moduleName/componentName`) for `currentFilePath`.
     *   2. Look up the component's props and find the one named `propName`.
     *   3. Get the prop's arg type (e.g. `NewCaseData`).
     *   4. Search workspace contexts for that type and return the field's location.
     */
    private resolveContextFieldInPropCall(
        fieldName: string,
        propName: string,
        currentFilePath: string
    ): Location | null {
        if (!this.workspace) return null

        // Reverse-look up the module/component key for this file
        let fileKey: string | null = null
        for (const [key, fp] of this.workspace.constructPaths) {
            if (fp === currentFilePath) { fileKey = key; break }
        }
        if (!fileKey) return null

        const [ownerModule, componentName] = fileKey.split('/')

        // Find the prop's arg type by searching views, screens, and providers
        const componentMaps = [
            this.workspace.views,
            this.workspace.screens,
            this.workspace.providers,
        ]
        let contextTypeName: string | null = null
        for (const moduleIndex of componentMaps) {
            const component = (moduleIndex as any).get(ownerModule)?.get(componentName)
            if (!component) continue
            const props: any[] = component.props ?? []
            const prop = props.find((p: any) => p.name === propName)
            if (prop?.type?.kind === 'NamedType') {
                contextTypeName = prop.type.name
                break
            }
        }
        if (!contextTypeName) return null

        // Search contexts — own module first, then all others
        const ordered = [
            [ownerModule, this.workspace.contexts.get(ownerModule)] as const,
            ...[...this.workspace.contexts.entries()].filter(([m]) => m !== ownerModule),
        ]
        for (const [moduleName, contextMap] of ordered) {
            if (!contextMap) continue
            const ctx = contextMap.get(contextTypeName)
            if (!ctx) continue
            const field = ctx.fields.find((f: any) => f.name === fieldName)
            if (!field) continue
            const ctxFilePath = this.workspace.constructPaths.get(`${moduleName}/${contextTypeName}`)
            if (ctxFilePath) return tokenLocation(ctxFilePath, field.token)
        }

        return null
    }

    /**
     * Searches all components with props (views, providers, adapters, interfaces)
     * for a prop whose `name` matches — navigates to the prop token.
     */
    private resolveViewPropByName(propName: string, inFilePath?: string): Location | null {
        return this.searchComponentProps((prop, filePath) => {
            if (inFilePath && filePath !== inFilePath) return null
            return prop.name === propName ? tokenLocation(filePath, prop.token) : null
        })
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

    /**
     * If `word` is the construct defined by `constructFilePath`, returns all
     * constructs whose uses tree references it. VS Code presents multiple
     * definition locations as a selectable list/peek view.
     */
    private resolveConsumersForConstructName(constructFilePath: string, word: string): Location[] {
        const target = this.resolveConstructByFilePath(constructFilePath)
        if (!target || target.name !== word) return []

        return this.resolveConstructConsumers(target.moduleName, target.name)
    }

    private resolveConstructByFilePath(filePath: string): { moduleName: string; name: string } | null {
        if (!this.workspace) return null

        for (const [key, constructPath] of this.workspace.constructPaths) {
            if (constructPath !== filePath) continue
            const [moduleName, name] = key.split('/')
            if (moduleName && name) return { moduleName, name }
        }

        return null
    }

    private resolveConstructConsumers(targetModuleName: string, targetName: string): Location[] {
        if (!this.workspace) return []

        const locations: Location[] = []

        this.collectConstructConsumers(this.workspace.states, targetModuleName, targetName, locations)
        this.collectConstructConsumers(this.workspace.screens, targetModuleName, targetName, locations)
        this.collectConstructConsumers(this.workspace.views, targetModuleName, targetName, locations)
        this.collectConstructConsumers(this.workspace.interfaces, targetModuleName, targetName, locations)

        return locations
    }

    private collectConstructConsumers(
        moduleIndex: Map<string, Map<string, { token: { line: number; column: number; value: string }; uses?: unknown[] }>>,
        targetModuleName: string,
        targetName: string,
        locations: Location[]
    ): void {
        if (!this.workspace) return

        for (const [consumerModuleName, constructMap] of moduleIndex) {
            for (const [consumerName, constructNode] of constructMap) {
                const uses = constructNode.uses ?? []
                if (!this.usesTreeReferencesConstruct(uses, consumerModuleName, targetModuleName, targetName)) continue

                const filePath = this.workspace.constructPaths.get(`${consumerModuleName}/${consumerName}`)
                if (filePath) locations.push(tokenLocation(filePath, constructNode.token))
            }
        }
    }

    private usesTreeReferencesConstruct(
        uses: unknown[],
        consumerModuleName: string,
        targetModuleName: string,
        targetName: string
    ): boolean {
        for (const entry of uses) {
            if (!isUseEntryLike(entry)) continue

            if (entry.kind === 'ComponentUse') {
                const resolved = resolveUsedConstruct(entry.name.parts, entry.componentKind, consumerModuleName)
                if (resolved?.moduleName === targetModuleName && resolved.name === targetName) return true
                if (this.usesTreeReferencesConstruct(entry.uses, consumerModuleName, targetModuleName, targetName)) return true
            } else if (entry.kind === 'ConditionalBlock' || entry.kind === 'IterationBlock') {
                if (this.usesTreeReferencesConstruct(entry.body, consumerModuleName, targetModuleName, targetName)) return true
            }
        }

        return false
    }

    /**
     * Given a method name, searches all module inline interfaces to determine
     * whether it belongs to a named (handler) interface or an anonymous one,
     * then returns the appropriate references:
     *
     *   - Named interface (e.g. `RouteSwitchHandler.switch`): returns all modules
     *     that have an `implements` block referencing that handler interface.
     *
     *   - Anonymous interface method (e.g. `subscribeRoute`): returns all modules
     *     that have a subscription call whose callee ends with that method name.
     *
     * Returns null if the method name is not found in any inline interface.
     */
    private resolveInterfaceMethodReferences(methodName: string): Location[] | null {
        if (!this.workspace) return null

        for (const [ownerModuleName, moduleNode] of this.workspace.modules) {
            for (const iface of moduleNode.inlineInterfaces) {
                for (const method of iface.methods) {
                    if (method.name !== methodName) continue

                    const ownerPath = this.workspace.modulePaths.get(ownerModuleName)
                    if (!ownerPath) return null

                    if (iface.name) {
                        // Named handler interface — find all modules that implement it
                        const qualifiedName = `${ownerModuleName}.${iface.name}`
                        const locations: Location[] = []
                        for (const [moduleName, mod] of this.workspace.modules) {
                            for (const impl of mod.implements) {
                                const implName = impl.interfaceName.parts.join('.')
                                if (implName === qualifiedName) {
                                    const filePath = this.workspace.modulePaths.get(moduleName)
                                    if (filePath) locations.push(tokenLocation(filePath, impl.token))
                                }
                            }
                        }
                        return locations
                    } else {
                        // Anonymous interface — find all modules with a matching subscription call
                        const locations: Location[] = []
                        for (const [moduleName, mod] of this.workspace.modules) {
                            for (const sub of mod.subscriptions) {
                                const callee = sub.callee
                                const parts: string[] = callee.kind === 'QualifiedName'
                                    ? callee.parts
                                    : (callee as any).path ?? []
                                if (parts[parts.length - 1] === methodName) {
                                    const filePath = this.workspace.modulePaths.get(moduleName)
                                    if (filePath) locations.push(tokenLocation(filePath, sub.token))
                                }
                            }
                        }
                        return locations
                    }
                }
            }
        }

        return null
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

function getIdentifierBounds(text: string, offset: number): { start: number; end: number } | null {
    if (offset < 0 || offset > text.length) return null

    let start = offset
    while (start > 0 && isIdentChar(text[start - 1])) start--

    let end = offset
    while (end < text.length && isIdentChar(text[end])) end++

    return start === end ? null : { start, end }
}

function getEnclosingAdapterUseName(text: string, offset: number): string | null {
    const before = text.slice(0, offset)
    const pattern = /\badapter\s+([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*\(/g
    let candidate: { name: string; openParen: number } | null = null
    let match: RegExpExecArray | null

    while ((match = pattern.exec(before)) !== null) {
        candidate = {
            name: match[1],
            openParen: match.index + match[0].lastIndexOf('('),
        }
    }

    if (!candidate) return null

    let depth = 0
    for (let i = candidate.openParen; i < offset; i++) {
        if (text[i] === '(') depth++
        if (text[i] === ')') depth--
    }

    return depth > 0 ? candidate.name : null
}

function resolveAdapterUseName(
    adapterUseName: string,
    currentModuleName: string | null
): { moduleName: string | null; adapterName: string; methodName: string } | null {
    const parts = adapterUseName.split('.')

    if (parts[0] === 'system' && parts.length >= 4) {
        return { moduleName: parts[1], adapterName: parts[2], methodName: parts[3] }
    }

    if (parts.length >= 3) {
        return { moduleName: parts[0], adapterName: parts[1], methodName: parts[2] }
    }

    if (parts.length === 2) {
        return { moduleName: currentModuleName, adapterName: parts[0], methodName: parts[1] }
    }

    return null
}

function isUseEntryLike(value: unknown): value is {
    kind: string
    componentKind: string
    name: { parts: string[] }
    uses: unknown[]
    body: unknown[]
} {
    return typeof value === 'object' && value !== null && 'kind' in value
}

function resolveUsedConstruct(
    parts: string[],
    componentKind: string,
    consumerModuleName: string
): { moduleName: string; name: string } | null {
    if (parts.length === 0) return null

    if (parts[0] === 'system') {
        if (parts.length < 3) return null
        return { moduleName: parts[1], name: parts[2] }
    }

    if (parts.length === 1) {
        return { moduleName: consumerModuleName, name: parts[0] }
    }

    if (componentKind === 'adapter' && parts.length === 2) {
        return { moduleName: consumerModuleName, name: parts[0] }
    }

    return { moduleName: parts[0], name: parts[1] }
}

/**
 * Scans backward from `position` in `document` to determine whether the cursor
 * sits inside a `props.propName( ... )` argument list. Returns the prop name
 * (e.g. `onSubmit`) if so, null otherwise.
 *
 * Strategy: walk backward tracking paren depth. When depth reaches 0 we found
 * the matching `(`. Then check that it is immediately preceded by `props.ident`.
 */
function getPropCallPropName(document: TextDocument, position: Position): string | null {
    const text = document.getText()
    const offset = document.offsetAt(position)

    let depth = 0
    let i = offset - 1
    while (i >= 0) {
        const ch = text[i]
        if (ch === ')') { depth++; i--; continue }
        if (ch === '(') {
            if (depth > 0) { depth--; i--; continue }
            // depth === 0 — this is our enclosing '('
            // Walk back past whitespace to find the identifier before it
            let j = i - 1
            while (j >= 0 && /[ \t]/.test(text[j])) j--
            // Read the identifier (propName)
            const nameEnd = j + 1
            while (j >= 0 && isIdentChar(text[j])) j--
            const propName = text.slice(j + 1, nameEnd)
            if (!propName) return null
            // Expect a '.' before propName
            if (j < 0 || text[j] !== '.') return null
            j--
            // Read the token before '.'
            const prefixEnd = j + 1
            while (j >= 0 && isIdentChar(text[j])) j--
            const prefix = text.slice(j + 1, prefixEnd)
            if (prefix === 'props') return propName
            return null
        }
        i--
    }
    return null
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
