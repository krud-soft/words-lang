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
    ScreenNode,
    SimpleReturnsNode,
    ExpandedReturnsNode,
    UseEntryNode,
    BlockExpressionNode,
    StateReturnStatementNode,
    ArgumentNode,
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
        this.checkProcessRules()
        this.checkStateReturns()
        this.checkStateReachability()
        this.checkScreenStateReturns()
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

                const returnedContexts = this.extractReturnedContexts(stateNode)

                for (const contextName of returnedContexts) {
                    if (!coveredReturns.has(`${stateName}::${contextName}`)) {
                        this.report(
                            filePath,
                            DiagnosticCode.A_UNHANDLED_RETURN,
                            `Context '${contextName}' is listed in state '${stateName}' returns but has no corresponding when rule in module '${moduleName}'`,
                            stateNode.token
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

            // Also collect all states referenced in implements branches
            for (const impl of moduleNode.implements) {
                for (const branch of impl.branches) {
                    reachable.add(branch.targetState)
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

                // Find the state that uses this screen
                const enclosingState = this.findStateUsingScreen(moduleName, screenName)
                if (!enclosingState) continue

                const validReturns = new Set(this.extractReturnedContexts(enclosingState))

                // Walk the screen's uses tree and check every state.return()
                this.checkStateReturnsInUses(screenNode.uses, validReturns, filePath, screenNode)
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
        screenNode: ScreenNode
    ): void {
        for (const entry of uses) {
            if (entry.kind === 'ComponentUse') {
                this.checkStateReturnsInArgs(entry.args, validReturns, filePath)
                this.checkStateReturnsInUses(entry.uses, validReturns, filePath, screenNode)
            } else if (entry.kind === 'ConditionalBlock') {
                this.checkStateReturnsInUses(entry.body, validReturns, filePath, screenNode)
            } else if (entry.kind === 'IterationBlock') {
                this.checkStateReturnsInUses(entry.body, validReturns, filePath, screenNode)
            }
        }
    }

    /**
     * Checks arguments for block expressions containing state.return() calls.
     */
    private checkStateReturnsInArgs(
        args: ArgumentNode[],
        validReturns: Set<string>,
        filePath: string
    ): void {
        for (const arg of args) {
            if (arg.value.kind === 'BlockExpression') {
                const block = arg.value as BlockExpressionNode
                for (const stmt of block.statements) {
                    if (stmt.kind === 'StateReturnStatement') {
                        const returnStmt = stmt as StateReturnStatementNode
                        if (!validReturns.has(returnStmt.contextName)) {
                            this.report(
                                filePath,
                                DiagnosticCode.A_INVALID_STATE_RETURN,
                                `state.return('${returnStmt.contextName}') does not match any context in the enclosing state's returns clause`,
                                returnStmt.token
                            )
                        }
                    }
                }
            }
        }
    }

    // ── Rule A007 — Ownership declarations match construct modules ─────────────

    /**
     * For every file with an ownerModule declaration, every construct in that
     * file must have its module field matching the ownerModule.
     * (The module field is filled in by the Workspace during indexing.)
     */
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
        if (!stateNode.returns) return []

        if (stateNode.returns.kind === 'SimpleReturns') {
            return (stateNode.returns as SimpleReturnsNode).contexts
        }

        if (stateNode.returns.kind === 'ExpandedReturns') {
            return (stateNode.returns as ExpandedReturnsNode).entries.map(e => e.contextName)
        }

        return []
    }

    /**
     * Finds the StateNode in `moduleName` that uses the given screen.
     * Returns null if no state in the module uses this screen.
     */
    private findStateUsingScreen(moduleName: string, screenName: string): StateNode | null {
        const stateMap = this.workspace.states.get(moduleName)
        if (!stateMap) return null

        for (const [, stateNode] of stateMap) {
            for (const entry of stateNode.uses) {
                if (
                    entry.kind === 'ComponentUse' &&
                    entry.componentKind === 'screen' &&
                    (entry.name.parts.length === 1
                        ? entry.name.parts[0] === screenName
                        : entry.name.parts[entry.name.parts.length - 1] === screenName)
                ) {
                    return stateNode
                }
            }
        }

        return null
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
