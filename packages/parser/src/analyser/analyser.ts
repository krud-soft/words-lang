/**
 * analyser.ts
 *
 * The WORDS semantic analyser. Walks the Workspace index and validates the
 * rules that cannot be checked by the parser alone — rules that require
 * cross-file knowledge of the full project.
 *
 * The analyser never reads files. It works entirely from the Workspace index
 * built by `Workspace.load()`. All diagnostics are collected and returned
 * as an array — nothing is thrown.
 *
 * Rules validated (first milestone):
 *
 *   A001 — Every module listed in system.modules has a ModuleNode definition.
 *   A002 — Every state referenced in a when rule exists as a StateNode.
 *   A003 — Every context referenced in a when rule exists as a ContextNode.
 *   A004 — Every context in a state's returns has a when rule in the process.
 *   A005 — Every state defined is reachable (referenced in a when rule or start).
 *   A006 — state.return(x) in a screen references a context in the state's returns.
 *   A007 — The module ownership declaration matches the construct's declared module.
 */

import { Workspace } from './workspace'
import {
    Diagnostic,
    DiagnosticCode,
    analyserDiagnostic,
    rangeFromToken,
} from './diagnostics'
import {
    StateNode,
    SimpleReturnsNode,
    ExpandedReturnsNode,
    UseEntryNode,
    ComponentUseNode,
    BlockExpressionNode,
    StateReturnStatementNode,
    PropNode,
    QualifiedName,
    CallExpressionNode,
    AccessExpressionNode,
    ContextNode,
    InterfaceNode,
    TypeNode,
    ExpressionNode,
} from '../parser/ast'

// ── AnalysisResult ────────────────────────────────────────────────────────────

/**
 * The value returned by `Analyser.analyse()`.
 * Contains all semantic diagnostics collected across the project, annotated
 * with the file path that produced each one.
 */
export interface AnalysisResult {
    diagnostics: Array<{ filePath: string; diagnostic: Diagnostic }>
}

// ── Analyser ──────────────────────────────────────────────────────────────────

export class Analyser {
    private workspace: Workspace
    private diagnostics: Array<{ filePath: string; diagnostic: Diagnostic }> = []

    constructor(workspace: Workspace) {
        this.workspace = workspace
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Runs all validation rules over the workspace index and returns the
     * collected diagnostics. Never throws.
     */
    analyse(): AnalysisResult {
        this.diagnostics = []

        this.checkSystemModules()
        this.checkImplementsInterfaces()
        this.checkProcessRules()
        this.checkStateContextReferences()
        this.checkStateReturns()
        this.checkStateReachability()
        this.checkComponentReferences()
        this.checkScreenStateReturns()
        this.checkAdapterUseArgs()
        this.checkPropCallContextFields()
        this.checkInterfaceIncludes()
        this.checkComponentRuntimeAccess()
        this.checkStateUseConstraints()
        this.checkComponentPropAssignments()
        this.checkOwnershipDeclarations()

        return { diagnostics: this.diagnostics }
    }

    // ── Rule A001 — System modules have definitions ────────────────────────────

    /**
     * Every module listed in system.modules must have a corresponding ModuleNode.
     * Reports on the system file using the module name token position.
     */
    private checkSystemModules(): void {
        const { system, systemFilePath } = this.workspace
        if (!system || !systemFilePath) return

        for (const moduleName of system.modules) {
            if (!this.workspace.modules.has(moduleName)) {
                this.report(
                    systemFilePath,
                    DiagnosticCode.A_UNDEFINED_MODULE,
                    `Module '${moduleName}' is listed in the system but has no definition`,
                    system.token
                )
            }
        }
    }

    // ── Rule A009 — Implements references declared interfaces ─────────────────

    private checkImplementsInterfaces(): void {
        for (const [moduleName, moduleNode] of this.workspace.modules) {
            const filePath = this.workspace.modulePaths.get(moduleName)
            if (!filePath) continue

            for (const impl of moduleNode.implements) {
                const target = this.resolveInterfaceName(impl.interfaceName, moduleName)
                if (!target) {
                    this.report(
                        filePath,
                        DiagnosticCode.A_UNDEFINED_INTERFACE,
                        `Interface '${impl.interfaceName.parts.join('.')}' referenced by implements is not declared`,
                        impl.interfaceName.token
                    )
                }
            }
        }
    }

    // ── Rules A002 + A003 — Process when rules reference valid constructs ───────

    /**
     * For every when rule in every process:
     * - The currentState must exist as a StateNode in the same module (A002)
     * - The nextState must exist as a StateNode in the same module (A002)
     * - The producedContext must exist as a ContextNode in the same module (A003)
     */
    private checkProcessRules(): void {
        for (const [moduleName, moduleNode] of this.workspace.modules) {
            const filePath = this.workspace.modulePaths.get(moduleName)
            if (!filePath) continue

            for (const process of moduleNode.processes) {
                for (const rule of process.rules) {

                    // Check currentState exists
                    if (!this.workspace.getState(moduleName, rule.currentState)) {
                        this.report(
                            filePath,
                            DiagnosticCode.A_UNDEFINED_STATE,
                            `State '${rule.currentState}' referenced in process '${process.name}' is not defined in module '${moduleName}'`,
                            rule.token
                        )
                    }

                    // Check nextState exists
                    if (!this.workspace.getState(moduleName, rule.nextState)) {
                        this.report(
                            filePath,
                            DiagnosticCode.A_UNDEFINED_STATE,
                            `State '${rule.nextState}' referenced in process '${process.name}' is not defined in module '${moduleName}'`,
                            rule.token
                        )
                    }

                    // Check producedContext exists
                    if (!this.workspace.getContext(moduleName, rule.producedContext)) {
                        this.report(
                            filePath,
                            DiagnosticCode.A_UNDEFINED_CONTEXT,
                            `Context '${rule.producedContext}' referenced in process '${process.name}' is not defined in module '${moduleName}'`,
                            rule.token
                        )
                    }
                }
            }
        }
    }

    private checkStateContextReferences(): void {
        for (const [moduleName, stateMap] of this.workspace.states) {
            for (const [stateName, state] of stateMap) {
                const filePath = this.workspace.constructPaths.get(`${moduleName}/${stateName}`)
                if (!filePath) continue

                if (state.receives && !this.workspace.getContext(moduleName, state.receives)) {
                    this.report(
                        filePath,
                        DiagnosticCode.A_UNDEFINED_CONTEXT,
                        `State '${stateName}' receives context '${state.receives}' that is not defined in module '${moduleName}'`,
                        state.token
                    )
                }

                for (const { name, token } of this.extractReturnedContextsWithTokens(state)) {
                    if (!this.workspace.getContext(moduleName, name)) {
                        this.report(
                            filePath,
                            DiagnosticCode.A_UNDEFINED_CONTEXT,
                            `State '${stateName}' returns context '${name}' that is not defined in module '${moduleName}'`,
                            token
                        )
                    }
                }
            }
        }
    }

    // ── Rule A004 — Every returned context has a when rule ─────────────────────

    /**
     * For every state, every context listed in its returns clause must have
     * a corresponding when rule in at least one of the module's processes.
     */
    private checkStateReturns(): void {
        for (const [moduleName, stateMap] of this.workspace.states) {
            const moduleNode = this.workspace.modules.get(moduleName)
            if (!moduleNode) continue

            // Build a set of all (currentState, producedContext) pairs covered by when rules
            const coveredReturns = new Set<string>()
            for (const process of moduleNode.processes) {
                for (const rule of process.rules) {
                    coveredReturns.add(`${rule.currentState}::${rule.producedContext}`)
                }
            }

            for (const [stateName, stateNode] of stateMap) {
                const filePath = this.workspace.constructPaths.get(`${moduleName}/${stateName}`)
                if (!filePath) continue

                for (const { name, token } of this.extractReturnedContextsWithTokens(stateNode)) {
                    if (!coveredReturns.has(`${stateName}::${name}`)) {
                        this.report(
                            filePath,
                            DiagnosticCode.A_UNHANDLED_RETURN,
                            `State '${stateName}' returns context '${name}' without a corresponding when rule in module '${moduleName}'`,
                            token
                        )
                    }
                }
            }
        }
    }

    // ── Rule A005 — Every state is reachable ───────────────────────────────────

    /**
     * Every state defined in a module must be either:
     * - The module's start state, or
     * - Referenced as the nextState in at least one when rule.
     *
     * States that are only currentState in when rules but never entered are
     * considered unreachable entry points.
     */
    private checkStateReachability(): void {
        for (const [moduleName, stateMap] of this.workspace.states) {
            const moduleNode = this.workspace.modules.get(moduleName)
            if (!moduleNode) continue

            // Collect all states that are entered (nextState in any when rule or start)
            const reachable = new Set<string>()
            if (moduleNode.startState) {
                reachable.add(moduleNode.startState)
            }
            for (const process of moduleNode.processes) {
                for (const rule of process.rules) {
                    reachable.add(rule.nextState)
                }
            }

            // Also collect all states referenced in implements blocks
            for (const impl of moduleNode.implements) {
                if (impl.kind === 'ImplementsHandler') {
                    for (const branch of impl.branches) {
                        reachable.add(branch.targetState)
                    }
                } else {
                    for (const action of impl.enterActions) {
                        reachable.add(action.targetState)
                    }
                }
            }

            for (const [stateName] of stateMap) {
                if (!reachable.has(stateName)) {
                    const filePath = this.workspace.constructPaths.get(`${moduleName}/${stateName}`)
                    if (!filePath) continue
                    const stateNode = stateMap.get(stateName)!
                    this.report(
                        filePath,
                        DiagnosticCode.A_UNREACHABLE_STATE,
                        `State '${stateName}' in module '${moduleName}' is never entered — it is not the start state and no when rule transitions into it`,
                        stateNode.token
                    )
                }
            }
        }
    }

    // ── Rule A006 — state.return() references valid contexts ──────────────────

    /**
     * For every screen, for every state.return(contextName) call found in its
     * uses tree, the contextName must appear in the enclosing state's returns.
     *
     * To find the enclosing state we look up which state uses this screen.
     */
    private checkScreenStateReturns(): void {
        for (const [moduleName, screenMap] of this.workspace.screens) {
            for (const [screenName, screenNode] of screenMap) {
                const filePath = this.workspace.constructPaths.get(`${moduleName}/${screenName}`)
                if (!filePath) continue

                // A screen can be mounted by more than one state. Validate its
                // state.return() calls against each mounting state's returns.
                for (const enclosingState of this.findStatesUsingScreen(moduleName, screenName)) {
                    const validReturns = new Set(this.extractReturnedContexts(enclosingState))
                    this.checkStateReturnsInUses(screenNode.uses, validReturns, filePath, moduleName, enclosingState)
                }
            }
        }
    }

    /**
     * Recursively walks a uses tree and validates every state.return() call.
     */
    private checkStateReturnsInUses(
        uses: UseEntryNode[],
        validReturns: Set<string>,
        filePath: string,
        enclosingModuleName: string,
        enclosingState: StateNode
    ): void {
        for (const entry of uses) {
            if (entry.kind === 'ComponentUse') {
                this.checkStateReturnsInArgs(entry, validReturns, filePath, enclosingModuleName, enclosingState)
                this.checkStateReturnsInUses(entry.uses, validReturns, filePath, enclosingModuleName, enclosingState)
            } else if (entry.kind === 'ConditionalBlock') {
                this.checkStateReturnsInUses(entry.body, validReturns, filePath, enclosingModuleName, enclosingState)
            } else if (entry.kind === 'IterationBlock') {
                this.checkStateReturnsInUses(entry.body, validReturns, filePath, enclosingModuleName, enclosingState)
            }
        }
    }

    /**
     * For each BlockExpression arg on a component use, validates every
     * state.return() call inside it.
     *
     * Two cases, determined by the target view's prop declaration for that arg:
     *
     *   - Prop has a named argument (e.g. `onSubmit credentials(AccountCredentials)`):
     *       state.return(x) must use x = argName. If it doesn't → A010.
     *       If it does, the prop's type must match a context in state's returns → A008.
     *
     *   - Prop has no named argument (e.g. `onPress`):
     *       state.return(x) treats x as a direct context name → A008 if not in returns.
     *
     * If the target view cannot be resolved, falls back to the direct context check.
     */
    private checkStateReturnsInArgs(
        componentUse: ComponentUseNode,
        validReturns: Set<string>,
        filePath: string,
        enclosingModuleName: string,
        enclosingState: StateNode
    ): void {
        const viewProps = this.resolveViewProps(componentUse.name, enclosingModuleName)

        for (const arg of componentUse.args) {
            if (arg.value.kind !== 'BlockExpression') continue

            const block = arg.value as BlockExpressionNode
            for (const stmt of block.statements) {
                if (stmt.kind !== 'StateReturnStatement') continue

                const returnStmt = stmt as StateReturnStatementNode
                const prop = viewProps?.find(p => p.name === arg.name) ?? null

                const returnToken = returnStmt.contextNameToken ?? returnStmt.token
                // PascalCase contextName or inline construction means a direct context type
                // reference — validate against validReturns. camelCase inside state.return(x)
                // is the old arg-binding form and must match the prop's argName.
                const isDirectContextRef = /^[A-Z]/.test(returnStmt.contextName) || returnStmt.inlineContext !== null
                if (prop?.argName && !isDirectContextRef) {
                    // Old form: state.return(argName) — must match the prop's declared arg
                    if (returnStmt.contextName !== prop.argName) {
                        this.report(
                            filePath,
                            DiagnosticCode.A_INVALID_HANDLER_ARG,
                            `Handler '${arg.name}' expects argument '${prop.argName}', not '${returnStmt.contextName}'`,
                            returnToken
                        )
                    } else if (
                        prop.type?.kind === 'NamedType' &&
                        prop.type.name !== '?' &&
                        !validReturns.has(prop.type.name)
                    ) {
                        this.report(
                            filePath,
                            DiagnosticCode.A_INVALID_STATE_RETURN,
                            this.describeInvalidReturnForState(
                                enclosingState,
                                prop.type.name,
                                `Arg '${prop.argName}' passed to prop '${arg.name}' produces '${prop.type.name}'`
                            ),
                            returnToken
                        )
                    }
                } else {
                    // Direct context type reference (PascalCase or inline construction),
                    // or prop has no argName — must be in the state's declared returns.
                    if (!validReturns.has(returnStmt.contextName)) {
                        const looksLikeArgRef = prop !== null && /^[a-z]/.test(returnStmt.contextName)
                        if (looksLikeArgRef) {
                            this.report(
                                filePath,
                                DiagnosticCode.A_INVALID_HANDLER_ARG,
                                `Handler '${arg.name}' has no argument — '${returnStmt.contextName}' is not a declared argument`,
                                returnToken
                            )
                        } else {
                            this.report(
                                filePath,
                                DiagnosticCode.A_INVALID_STATE_RETURN,
                                this.describeInvalidReturnForState(
                                    enclosingState,
                                    returnStmt.contextName,
                                    `state.return('${returnStmt.contextName}')`
                                ),
                                returnToken
                            )
                        }
                    }
                }
            }
        }
    }

    /**
     * Resolves the props of a view component by its qualified name.
     * Returns null if the view is not found in the workspace.
     *
     * For unqualified names (e.g. `DiagnosisConfirmation`), the enclosing
     * module is used. For qualified names (e.g. `UIModule.LoginForm`), the
     * first part is the module name.
     */
    private resolveViewProps(name: QualifiedName, enclosingModuleName: string): PropNode[] | null {
        const moduleName = name.parts.length === 1 ? enclosingModuleName : name.parts[0]
        const viewName = name.parts[name.parts.length - 1]

        const viewMap = this.workspace.views.get(moduleName)
        if (!viewMap) return null
        const view = viewMap.get(viewName)
        return view ? view.props : null
    }

    // ── Rule A007 — Ownership declarations match construct modules ─────────────

    /**
     * For every file with an ownerModule declaration, every construct in that
     * file must have its module field matching the ownerModule.
     * (The module field is filled in by the Workspace during indexing.)
     */
    // ── Rule A011 — Adapter use arguments match method params ──────────────────

    /**
     * For every adapter ComponentUseNode across all component uses trees,
     * validates that each argument name matches a parameter
     * declared on the referenced adapter method.
     */
    private checkAdapterUseArgs(): void {
        // Collect all (filePath, uses[]) pairs from every construct that has a uses block
        const usesEntries: Array<{ filePath: string; uses: UseEntryNode[] }> = []

        for (const [moduleName, stateMap] of this.workspace.states) {
            for (const [stateName, stateNode] of stateMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${stateName}`)
                if (fp) usesEntries.push({ filePath: fp, uses: stateNode.uses })
            }
        }
        for (const [moduleName, screenMap] of this.workspace.screens) {
            for (const [screenName, screenNode] of screenMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${screenName}`)
                if (fp) usesEntries.push({ filePath: fp, uses: screenNode.uses })
            }
        }
        for (const [moduleName, viewMap] of this.workspace.views) {
            for (const [viewName, viewNode] of viewMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${viewName}`)
                if (fp) usesEntries.push({ filePath: fp, uses: viewNode.uses })
            }
        }
        for (const [moduleName, providerMap] of this.workspace.providers) {
            for (const [providerName, providerNode] of providerMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${providerName}`)
                if (fp) usesEntries.push({ filePath: fp, uses: (providerNode as any).uses ?? [] })
            }
        }
        for (const [moduleName, ifaceMap] of this.workspace.interfaces) {
            for (const [ifaceName, ifaceNode] of ifaceMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${ifaceName}`)
                if (fp) usesEntries.push({ filePath: fp, uses: ifaceNode.uses })
            }
        }

        for (const { filePath, uses } of usesEntries) {
            this.checkAdapterArgsInUses(uses, filePath)
        }
    }

    private checkAdapterArgsInUses(uses: UseEntryNode[], filePath: string): void {
        for (const entry of uses) {
            if (entry.kind === 'ComponentUse') {
                if (entry.componentKind === 'adapter') {
                    this.validateAdapterArgs(entry as ComponentUseNode, filePath)
                }
                this.checkAdapterArgsInUses(entry.uses, filePath)
            } else if (entry.kind === 'ConditionalBlock' || entry.kind === 'IterationBlock') {
                this.checkAdapterArgsInUses(entry.body, filePath)
            }
        }
    }

    private validateAdapterArgs(use: ComponentUseNode, filePath: string): void {
        // Resolve adapter and method from the qualified name.
        // Supported forms: AdapterName.methodName or system.ModuleName.AdapterName.methodName
        const parts = use.name.parts
        const methodName = parts[parts.length - 1]
        const adapterName = parts[parts.length - 2]
        if (!adapterName || !methodName) return

        // Find the adapter across all modules
        let methodParams: string[] | null = null
        for (const [, adapterMap] of this.workspace.adapters) {
            const adapter = adapterMap.get(adapterName)
            if (!adapter) continue
            const method = adapter.methods.find(m => m.name === methodName)
            if (method) {
                methodParams = method.params.map(p => p.name)
                break
            }
        }
        if (methodParams === null) return // adapter or method not found — skip

        for (const arg of use.args) {
            if (!methodParams.includes(arg.name)) {
                const validList = methodParams.length > 0 ? methodParams.join(', ') : 'none'
                this.report(
                    filePath,
                    DiagnosticCode.A_UNKNOWN_ADAPTER_ARG,
                    `'${methodName}' has no argument '${arg.name}' (valid: ${validList})`,
                    arg.token
                )
            }
        }
    }

    // ── Rule A006 — Component references resolve ──────────────────────────────

    private checkComponentReferences(): void {
        for (const [moduleName, stateMap] of this.workspace.states) {
            for (const [stateName, state] of stateMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${stateName}`)
                if (fp) this.checkComponentReferencesInUses(state.uses, moduleName, fp)
            }
        }
        for (const [moduleName, screenMap] of this.workspace.screens) {
            for (const [screenName, screen] of screenMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${screenName}`)
                if (fp) this.checkComponentReferencesInUses(screen.uses, moduleName, fp)
            }
        }
        for (const [moduleName, viewMap] of this.workspace.views) {
            for (const [viewName, view] of viewMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${viewName}`)
                if (fp) this.checkComponentReferencesInUses(view.uses, moduleName, fp)
            }
        }
        for (const [moduleName, ifaceMap] of this.workspace.interfaces) {
            for (const [ifaceName, iface] of ifaceMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${ifaceName}`)
                if (fp) this.checkComponentReferencesInUses(iface.uses, moduleName, fp)
            }
        }
    }

    private checkComponentReferencesInUses(
        uses: UseEntryNode[],
        enclosingModuleName: string,
        filePath: string
    ): void {
        for (const entry of uses) {
            if (entry.kind === 'ComponentUse') {
                if (!this.componentUseResolves(entry, enclosingModuleName)) {
                    this.report(
                        filePath,
                        DiagnosticCode.A_UNDEFINED_COMPONENT,
                        `Component '${entry.name.parts.join('.')}' cannot be resolved`,
                        entry.token
                    )
                }
                this.checkComponentReferencesInUses(entry.uses, enclosingModuleName, filePath)
            } else if (entry.kind === 'ConditionalBlock' || entry.kind === 'IterationBlock') {
                this.checkComponentReferencesInUses(entry.body, enclosingModuleName, filePath)
            }
        }
    }

    private componentUseResolves(use: ComponentUseNode, enclosingModuleName: string): boolean {
        const resolved = this.resolveComponentName(use, enclosingModuleName)
        if (!resolved) return false

        switch (use.componentKind) {
            case 'screen':
                return this.workspace.screens.get(resolved.moduleName)?.has(resolved.componentName) ?? false
            case 'view':
                return this.workspace.views.get(resolved.moduleName)?.has(resolved.componentName) ?? false
            case 'adapter':
                return this.workspace.adapters.get(resolved.moduleName)?.has(resolved.componentName) ?? false
            case 'provider':
                return this.workspace.providers.get(resolved.moduleName)?.has(resolved.componentName) ?? false
            case 'interface':
                return this.workspace.interfaces.get(resolved.moduleName)?.has(resolved.componentName) ?? false
        }
    }

    private resolveComponentName(
        use: ComponentUseNode,
        enclosingModuleName: string
    ): { moduleName: string; componentName: string } | null {
        const parts = use.name.parts
        if (parts.length === 0) return null

        if (parts[0] === 'system') {
            if (parts.length < 3) return null
            return { moduleName: parts[1], componentName: parts[2] }
        }

        if (parts.length === 1) {
            return { moduleName: enclosingModuleName, componentName: parts[0] }
        }

        if (use.componentKind === 'adapter' && parts.length === 2) {
            return { moduleName: enclosingModuleName, componentName: parts[0] }
        }

        return { moduleName: parts[0], componentName: parts[1] }
    }

    // ── Rule A012 — props.propName(...) provides all context fields ───────────────

    /**
     * For every `props.propName( fieldName is value, ... )` call expression
     * found in a component's uses tree, verifies that all required fields of
     * the context type declared on that prop are provided.
     *
     * e.g. if `onSubmit newCaseData(NewCaseData)` is a prop and `NewCaseData`
     * has five fields, calling `props.onSubmit( photoIds is x )` must include
     * all five fields — missing ones are reported as A012.
     */
    private checkPropCallContextFields(): void {
        const entries: Array<{ filePath: string; componentProps: PropNode[]; uses: UseEntryNode[]; moduleName: string }> = []

        for (const [moduleName, viewMap] of this.workspace.views) {
            for (const [viewName, viewNode] of viewMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${viewName}`)
                if (fp) entries.push({ filePath: fp, componentProps: viewNode.props, uses: viewNode.uses, moduleName })
            }
        }
        for (const [moduleName, screenMap] of this.workspace.screens) {
            for (const [screenName, screenNode] of screenMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${screenName}`)
                if (fp) entries.push({ filePath: fp, componentProps: (screenNode as any).props ?? [], uses: screenNode.uses, moduleName })
            }
        }
        for (const [moduleName, providerMap] of this.workspace.providers) {
            for (const [providerName, providerNode] of providerMap) {
                const fp = this.workspace.constructPaths.get(`${moduleName}/${providerName}`)
                if (fp) entries.push({ filePath: fp, componentProps: (providerNode as any).props ?? [], uses: (providerNode as any).uses ?? [], moduleName })
            }
        }

        for (const { filePath, componentProps, uses, moduleName } of entries) {
            this.checkPropCallsInUses(uses, componentProps, filePath, moduleName)
        }
    }

    private checkPropCallsInUses(
        uses: UseEntryNode[],
        componentProps: PropNode[],
        filePath: string,
        moduleName: string
    ): void {
        for (const entry of uses) {
            if (entry.kind === 'ComponentUse') {
                const use = entry as ComponentUseNode
                for (const arg of use.args) {
                    if (arg.value.kind !== 'CallExpression') continue
                    const callExpr = arg.value as CallExpressionNode
                    if (callExpr.callee.kind !== 'AccessExpression') continue
                    const path = (callExpr.callee as AccessExpressionNode).path
                    if (path[0] !== 'props' || path.length < 2) continue

                    const propName = path[1]
                    const prop = componentProps.find(p => p.name === propName)
                    if (!prop || !prop.argName || !prop.type || prop.type.kind !== 'NamedType') continue

                    const contextTypeName = (prop.type as any).name as string
                    const context = this.resolveContextByName(contextTypeName, moduleName)
                    if (!context) continue

                    const providedFields = new Set(callExpr.args.map(a => a.name))
                    const missingFields = context.fields
                        .filter(f => !f.optional && !providedFields.has(f.name))
                        .map(f => f.name)

                    if (missingFields.length > 0) {
                        this.report(
                            filePath,
                            DiagnosticCode.A_MISSING_CONTEXT_FIELD,
                            `props.${propName}(...) is missing fields for '${contextTypeName}': ${missingFields.join(', ')}`,
                            callExpr.token
                        )
                    }
                }
                this.checkPropCallsInUses(use.uses, componentProps, filePath, moduleName)
            } else if (entry.kind === 'ConditionalBlock' || entry.kind === 'IterationBlock') {
                this.checkPropCallsInUses((entry as any).body, componentProps, filePath, moduleName)
            }
        }
    }

    /**
     * Resolves a context by name, searching the enclosing module first then all modules.
     */
    private resolveContextByName(contextName: string, enclosingModuleName: string): ContextNode | null {
        const own = this.workspace.getContext(enclosingModuleName, contextName)
        if (own) return own
        for (const [, contextMap] of this.workspace.contexts) {
            const ctx = contextMap.get(contextName)
            if (ctx) return ctx
        }
        return null
    }

    // ── Rules A013-A016 — Interface includes semantics ────────────────────────

    private checkInterfaceIncludes(): void {
        for (const [moduleName, ifaceMap] of this.workspace.interfaces) {
            for (const [ifaceName, iface] of ifaceMap) {
                const filePath = this.workspace.constructPaths.get(`${moduleName}/${ifaceName}`)
                if (!filePath) continue

                if (iface.includes.length > 0 && !this.isDataInterface(iface)) {
                    this.report(
                        filePath,
                        DiagnosticCode.A_INVALID_INTERFACE_INCLUDE,
                        `Interface '${ifaceName}' cannot include other interfaces because it declares behavior`,
                        iface.token
                    )
                }

                for (const includeName of iface.includes) {
                    const included = this.resolveInterfaceName(includeName, moduleName)
                    if (!included) {
                        this.report(
                            filePath,
                            DiagnosticCode.A_UNDEFINED_INCLUDED_INTERFACE,
                            `Included interface '${includeName.parts.join('.')}' cannot be resolved`,
                            includeName.token
                        )
                        continue
                    }

                    if (!this.isDataInterface(included.node)) {
                        this.report(
                            filePath,
                            DiagnosticCode.A_INVALID_INTERFACE_INCLUDE,
                            `Interface '${ifaceName}' cannot include behavioral interface '${included.name}'`,
                            includeName.token
                        )
                    }
                }

                if (this.hasIncludesCycle(moduleName, ifaceName)) {
                    this.report(
                        filePath,
                        DiagnosticCode.A_CYCLIC_INTERFACE_INCLUDE,
                        `Interface '${ifaceName}' has a cyclic includes relationship`,
                        iface.token
                    )
                }

                const duplicate = this.findIncompatibleIncludedProp(moduleName, ifaceName)
                if (duplicate) {
                    this.report(
                        filePath,
                        DiagnosticCode.A_DUPLICATE_INTERFACE_PROP,
                        `Included interfaces declare prop '${duplicate}' with incompatible types`,
                        iface.token
                    )
                }
            }
        }
    }

    // ── Rules A017-A018 — Component layer access/use constraints ──────────────

    private checkComponentRuntimeAccess(): void {
        for (const [moduleName, viewMap] of this.workspace.views) {
            for (const [viewName, view] of viewMap) {
                const filePath = this.workspace.constructPaths.get(`${moduleName}/${viewName}`)
                if (!filePath) continue
                this.checkInvalidRuntimeAccessInUses(view.uses, filePath, 'view')
            }
        }
    }

    private checkInvalidRuntimeAccessInUses(
        uses: UseEntryNode[],
        filePath: string,
        componentKind: 'view'
    ): void {
        for (const entry of uses) {
            if (entry.kind === 'ComponentUse') {
                for (const arg of entry.args) {
                    this.checkInvalidRuntimeAccessInExpression(arg.value, filePath, componentKind)
                }
                this.checkInvalidRuntimeAccessInUses(entry.uses, filePath, componentKind)
            } else if (entry.kind === 'ConditionalBlock') {
                this.checkInvalidRuntimeAccessInExpression(entry.condition.left, filePath, componentKind)
                this.checkInvalidRuntimeAccessInExpression(entry.condition.right, filePath, componentKind)
                this.checkInvalidRuntimeAccessInUses(entry.body, filePath, componentKind)
            } else if (entry.kind === 'IterationBlock') {
                this.checkInvalidRuntimeAccessInExpression(entry.collection, filePath, componentKind)
                this.checkInvalidRuntimeAccessInUses(entry.body, filePath, componentKind)
            } else if (entry.kind === 'CallExpression') {
                for (const arg of entry.args) {
                    this.checkInvalidRuntimeAccessInExpression(arg.value, filePath, componentKind)
                }
            }
        }
    }

    private checkInvalidRuntimeAccessInExpression(
        expression: ExpressionNode,
        filePath: string,
        componentKind: 'view'
    ): void {
        if (expression.kind === 'AccessExpression') {
            const access = expression as AccessExpressionNode
            if (componentKind === 'view' && access.path[0] === 'context') {
                this.report(
                    filePath,
                    DiagnosticCode.A_INVALID_RUNTIME_ACCESS,
                    `Views cannot read '${access.path.join('.')}' directly; pass data through props`,
                    access.token
                )
            }
        } else if (expression.kind === 'CallExpression') {
            const call = expression as CallExpressionNode
            for (const arg of call.args) {
                this.checkInvalidRuntimeAccessInExpression(arg.value, filePath, componentKind)
            }
        } else if (expression.kind === 'BlockExpression') {
            const block = expression as BlockExpressionNode
            for (const stmt of block.statements) {
                if (stmt.kind === 'StateReturnStatement' && componentKind === 'view') {
                    this.report(
                        filePath,
                        DiagnosticCode.A_INVALID_RUNTIME_ACCESS,
                        `Views cannot call state.return directly; expose a callback prop instead`,
                        stmt.token
                    )
                } else if (stmt.kind === 'AssignmentStatement') {
                    this.checkInvalidRuntimeAccessInExpression(stmt.value, filePath, componentKind)
                }
            }
        }
    }

    private checkStateUseConstraints(): void {
        for (const [moduleName, stateMap] of this.workspace.states) {
            for (const [stateName, state] of stateMap) {
                const filePath = this.workspace.constructPaths.get(`${moduleName}/${stateName}`)
                if (!filePath) continue
                for (const entry of state.uses) {
                    if (entry.kind === 'ComponentUse' && entry.componentKind === 'view') {
                        this.report(
                            filePath,
                            DiagnosticCode.A_INVALID_STATE_USE,
                            `State '${stateName}' cannot use view '${entry.name.parts.join('.')}' directly; use a screen as the UI root`,
                            entry.token
                        )
                    }
                }
            }
        }
    }

    // ── Rule A019 — Prop assignment type compatibility ────────────────────────

    private checkComponentPropAssignments(): void {
        for (const [moduleName, viewMap] of this.workspace.views) {
            for (const [viewName, view] of viewMap) {
                const filePath = this.workspace.constructPaths.get(`${moduleName}/${viewName}`)
                if (!filePath) continue
                this.checkPropAssignmentsInUses(view.uses, view.props, moduleName, filePath)
            }
        }
    }

    private checkPropAssignmentsInUses(
        uses: UseEntryNode[],
        sourceProps: PropNode[],
        moduleName: string,
        filePath: string
    ): void {
        for (const entry of uses) {
            if (entry.kind === 'ComponentUse') {
                const targetProps = this.resolveComponentProps(entry, moduleName)
                if (targetProps) {
                    for (const arg of entry.args) {
                        const expected = targetProps.find(p => p.name === arg.name)
                        if (!expected?.type) continue

                        const actualType = this.inferExpressionTypeFromProps(arg.value, sourceProps)
                        if (!actualType) continue

                        if (!this.isAssignableType(actualType, expected.type, moduleName)) {
                            this.report(
                                filePath,
                                DiagnosticCode.A_INVALID_TYPE_ASSIGNMENT,
                                `Argument '${arg.name}' is not assignable to '${this.typeToString(expected.type)}'`,
                                arg.token
                            )
                        }
                    }
                }
                this.checkPropAssignmentsInUses(entry.uses, sourceProps, moduleName, filePath)
            } else if (entry.kind === 'ConditionalBlock' || entry.kind === 'IterationBlock') {
                this.checkPropAssignmentsInUses(entry.body, sourceProps, moduleName, filePath)
            }
        }
    }

    private checkOwnershipDeclarations(): void {
        for (const [filePath, record] of this.workspace.files) {
            const doc = record.parseResult.document
            if (!doc.ownerModule) continue

            for (const node of doc.nodes) {
                if (!('module' in node)) continue
                const nodeModule = (node as any).module as string
                if (nodeModule && nodeModule !== doc.ownerModule) {
                    this.report(
                        filePath,
                        DiagnosticCode.A_MODULE_MISMATCH,
                        `Construct declares module '${nodeModule}' but the ownership declaration says '${doc.ownerModule}'`,
                        node.token
                    )
                }
            }
        }
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /**
     * Extracts all context names from a state's returns clause,
     * handling both simple and expanded forms.
     */
    private extractReturnedContexts(stateNode: StateNode): string[] {
        return this.extractReturnedContextsWithTokens(stateNode).map(e => e.name)
    }

    /**
     * Extracts all context names and their source tokens from a state's returns clause.
     * For simple returns, uses the per-context token stored at parse time.
     * For expanded returns, uses the ExpandedReturnNode's own token.
     */
    private extractReturnedContextsWithTokens(stateNode: StateNode): Array<{ name: string; token: { line: number; column: number; value: string } }> {
        if (!stateNode.returns) return []

        if (stateNode.returns.kind === 'SimpleReturns') {
            const node = stateNode.returns as SimpleReturnsNode
            return node.contexts.map((name, i) => ({
                name,
                token: node.contextTokens[i] ?? node.token,
            }))
        }

        if (stateNode.returns.kind === 'ExpandedReturns') {
            return (stateNode.returns as ExpandedReturnsNode).entries.map(e => ({
                name: e.contextName,
                token: e.token,
            }))
        }

        return []
    }

    /**
     * Finds every StateNode in `moduleName` that uses the given screen.
     */
    private findStatesUsingScreen(moduleName: string, screenName: string): StateNode[] {
        const stateMap = this.workspace.states.get(moduleName)
        if (!stateMap) return []

        const states: StateNode[] = []

        for (const [, stateNode] of stateMap) {
            for (const entry of stateNode.uses) {
                if (
                    entry.kind === 'ComponentUse' &&
                    entry.componentKind === 'screen' &&
                    (entry.name.parts.length === 1
                        ? entry.name.parts[0] === screenName
                        : entry.name.parts[0] === moduleName && entry.name.parts[entry.name.parts.length - 1] === screenName)
                ) {
                    states.push(stateNode)
                    break
                }
            }
        }

        return states
    }

    private describeInvalidReturnForState(stateNode: StateNode, producedContext: string, prefix: string): string {
        const expected = this.extractReturnedContexts(stateNode).join(', ') || 'none'
        return `${prefix}, but state '${stateNode.name}' does not return '${producedContext}' (state returns: ${expected})`
    }

    private resolveInterfaceName(
        name: QualifiedName,
        enclosingModuleName: string
    ): { moduleName: string; name: string; node: InterfaceNode } | null {
        const moduleName = name.parts.length === 1 ? enclosingModuleName : name.parts[0]
        const ifaceName = name.parts[name.parts.length - 1]
        const node = this.workspace.interfaces.get(moduleName)?.get(ifaceName)
        return node ? { moduleName, name: ifaceName, node } : null
    }

    private isDataInterface(iface: InterfaceNode): boolean {
        return iface.methods.length === 0 && iface.state.length === 0 && iface.uses.length === 0
    }

    private hasIncludesCycle(moduleName: string, ifaceName: string): boolean {
        const startKey = `${moduleName}/${ifaceName}`
        const visiting = new Set<string>()
        const visited = new Set<string>()

        const visit = (currentModule: string, currentName: string): boolean => {
            const key = `${currentModule}/${currentName}`
            if (visiting.has(key)) return key === startKey
            if (visited.has(key)) return false

            const iface = this.workspace.interfaces.get(currentModule)?.get(currentName)
            if (!iface) return false

            visiting.add(key)
            for (const includeName of iface.includes) {
                const included = this.resolveInterfaceName(includeName, currentModule)
                if (included && visit(included.moduleName, included.name)) {
                    return true
                }
            }
            visiting.delete(key)
            visited.add(key)
            return false
        }

        return visit(moduleName, ifaceName)
    }

    private findIncompatibleIncludedProp(moduleName: string, ifaceName: string): string | null {
        const seen = new Map<string, TypeNode | null>()
        const visited = new Set<string>()

        const visitProps = (currentModule: string, currentName: string): string | null => {
            const key = `${currentModule}/${currentName}`
            if (visited.has(key)) return null
            visited.add(key)

            const iface = this.workspace.interfaces.get(currentModule)?.get(currentName)
            if (!iface) return null

            for (const prop of iface.props) {
                const previous = seen.get(prop.name)
                if (previous !== undefined && !this.sameType(previous, prop.type)) {
                    return prop.name
                }
                seen.set(prop.name, prop.type)
            }

            for (const includeName of iface.includes) {
                const included = this.resolveInterfaceName(includeName, currentModule)
                if (!included) continue
                const duplicate = visitProps(included.moduleName, included.name)
                if (duplicate) return duplicate
            }

            return null
        }

        return visitProps(moduleName, ifaceName)
    }

    private resolveComponentProps(use: ComponentUseNode, enclosingModuleName: string): PropNode[] | null {
        const moduleName = use.name.parts.length === 1 ? enclosingModuleName : use.name.parts[0]
        const componentName = use.name.parts[use.name.parts.length - 1]

        if (use.componentKind === 'view') {
            return this.workspace.views.get(moduleName)?.get(componentName)?.props ?? null
        }
        if (use.componentKind === 'interface') {
            return this.workspace.interfaces.get(moduleName)?.get(componentName)?.props ?? null
        }
        return null
    }

    private inferExpressionTypeFromProps(expression: ExpressionNode, sourceProps: PropNode[]): TypeNode | null {
        if (expression.kind !== 'AccessExpression') return null
        const access = expression as AccessExpressionNode
        if (access.path[0] !== 'props' || access.path.length < 2) return null
        return sourceProps.find(p => p.name === access.path[1])?.type ?? null
    }

    private isAssignableType(actual: TypeNode, expected: TypeNode, enclosingModuleName: string): boolean {
        if (this.sameType(actual, expected)) return true
        if (actual.kind !== 'NamedType' || expected.kind !== 'NamedType') return false
        return this.interfaceIncludes(actual.name, expected.name, enclosingModuleName)
    }

    private interfaceIncludes(actualName: string, expectedName: string, enclosingModuleName: string): boolean {
        const visited = new Set<string>()

        const visit = (currentModule: string, currentName: string): boolean => {
            const key = `${currentModule}/${currentName}`
            if (visited.has(key)) return false
            visited.add(key)

            const iface = this.workspace.interfaces.get(currentModule)?.get(currentName)
            if (!iface) return false

            for (const includeName of iface.includes) {
                const included = this.resolveInterfaceName(includeName, currentModule)
                if (!included) continue
                if (included.name === expectedName) return true
                if (visit(included.moduleName, included.name)) return true
            }
            return false
        }

        return visit(enclosingModuleName, actualName)
    }

    private sameType(left: TypeNode | null, right: TypeNode | null): boolean {
        if (left === null || right === null) return left === right
        if (left.kind !== right.kind) return false

        if (left.kind === 'PrimitiveType' && right.kind === 'PrimitiveType') {
            return left.name === right.name && left.optional === right.optional
        }
        if (left.kind === 'NamedType' && right.kind === 'NamedType') {
            return left.name === right.name && left.optional === right.optional
        }
        if (left.kind === 'ListType' && right.kind === 'ListType') {
            return this.sameType(left.elementType, right.elementType)
        }
        if (left.kind === 'MapType' && right.kind === 'MapType') {
            return this.sameType(left.keyType, right.keyType) && this.sameType(left.valueType, right.valueType)
        }
        return false
    }

    private typeToString(type: TypeNode): string {
        if (type.kind === 'PrimitiveType') return `${type.optional ? '?' : ''}${type.name}`
        if (type.kind === 'NamedType') return `${type.optional ? '?' : ''}${type.name}`
        if (type.kind === 'ListType') return `list(${this.typeToString(type.elementType)})`
        if (type.kind === 'MapType') return `map(${this.typeToString(type.keyType)}, ${this.typeToString(type.valueType)})`
        return '?'
    }

    /**
     * Emits a diagnostic at the position of the given token.
     */
    private report(
        filePath: string,
        code: DiagnosticCode,
        message: string,
        token: { line: number; column: number; value: string }
    ): void {
        const range = rangeFromToken(token.line, token.column, token.value.length || 1)
        this.diagnostics.push({
            filePath,
            diagnostic: analyserDiagnostic(code, message, 'error', range),
        })
    }
}
