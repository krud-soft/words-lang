/**
 * parser.ts
 *
 * The WORDS parser. Consumes a flat token stream produced by the Lexer and
 * builds an AST described in ast.ts.
 *
 * Design principles:
 *
 * - Recursive descent. Each grammar rule has a corresponding private method.
 *   Methods consume tokens and return AST nodes.
 *
 * - Error recovery. When an unexpected token is encountered the parser emits
 *   a diagnostic, skips tokens until it finds a safe synchronisation point
 *   (typically a newline, a closing paren, or a known top-level keyword), and
 *   continues. This means a single parse pass collects all errors in the file.
 *
 * - No exceptions for parse errors. All problems are collected in `this.diagnostics`
 *   and returned alongside the partial AST in the `ParseResult`.
 *
 * - Comments and newlines are consumed transparently by the `skip()` helper
 *   unless the calling rule explicitly needs them (e.g. ownership declaration
 *   detection requires newlines).
 *
 * - `system` and `state` are both keywords and identifier prefixes in access
 *   expressions (`system.setContext`, `state.context`). The parser disambiguates
 *   by context — inside a `uses` block or argument value position, these are
 *   treated as access expression roots, not construct keywords.
 */

import {
    DocumentNode,
    TopLevelNode,
    SystemNode,
    ModuleNode,
    StateNode,
    ContextNode,
    ScreenNode,
    ViewNode,
    ProviderNode,
    AdapterNode,
    InterfaceNode,
    ProcessNode,
    WhenRuleNode,
    InlineContextNode,
    ImplementsHandlerNode,
    ImplementsBranchNode,
    ImplementsCallbackNode,
    ImplementsEnterActionNode,
    PropNode,
    MethodNode,
    TypeNode,
    PrimitiveType,
    PrimitiveTypeNode,
    ListTypeNode,
    MapTypeNode,
    NamedTypeNode,
    ReturnsNode,
    SimpleReturnsNode,
    ExpandedReturnsNode,
    ExpandedReturnNode,
    SideEffectNode,
    ArgumentNode,
    UseEntryNode,
    ComponentUseNode,
    ConditionalBlockNode,
    IterationBlockNode,
    ConditionNode,
    ExpressionNode,
    AccessExpressionNode,
    CallExpressionNode,
    StateReturnExpressionNode,
    BlockExpressionNode,
    StatementNode,
    AssignmentStatementNode,
    StateReturnStatementNode,
    LiteralNode,
    StringLiteralNode,
    IntegerLiteralNode,
    FloatLiteralNode,
    BooleanLiteralNode,
    ListLiteralNode,
    MapLiteralNode,
    QualifiedName,
} from './ast'

import { Token, TokenType } from '../lexer/token'
import {
    Diagnostic,
    DiagnosticCode,
} from '../analyser/diagnostics'
import { ParserCursor } from './cursor'

// ── Parse result ──────────────────────────────────────────────────────────────

/**
 * The value returned by `Parser.parse()`.
 * Always contains both a (possibly partial) document and all diagnostics
 * collected during the parse — even when errors were encountered.
 */
export interface ParseResult {
    document: DocumentNode
    diagnostics: Diagnostic[]
}

// ── Parser ────────────────────────────────────────────────────────────────────

export class Parser {
    /** Token-stream cursor and parse diagnostic collector. */
    private cursor: ParserCursor

    constructor(tokens: Token[]) {
        this.cursor = new ParserCursor(tokens)
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Parses the entire token stream and returns a ParseResult containing
     * the document AST and all collected diagnostics.
     * Never throws — all errors are collected as diagnostics.
     */
    parse(): ParseResult {
        const document = this.parseDocument()
        return { document, diagnostics: this.cursor.diagnostics }
    }

    // ── Document ───────────────────────────────────────────────────────────────

    /**
     * Parses a complete `.wds` file.
     *
     * Detects the ownership declaration pattern — a bare `module ModuleName`
     * on its own line at the top of component files. If the first non-trivial
     * content is `module PascalIdent Newline` (with no opening `(`), it is
     * captured as `ownerModule` and the next construct is parsed normally.
     */
    private parseDocument(): DocumentNode {
        this.skipComments()

        let ownerModule: string | null = null

        // Detect ownership declaration: module ModuleName \n (no body follows)
        if (this.check(TokenType.Module)) {
            const saved = this.pos
            this.advance() // consume 'module'
            this.skipComments()
            if (this.check(TokenType.PascalIdent)) {
                const name = this.current().value
                this.advance() // consume name
                this.skipComments()
                // If the next meaningful token is a newline or EOF (not a string or '('),
                // this is an ownership declaration, not a module definition.
                if (this.check(TokenType.Newline) || this.check(TokenType.EOF)) {
                    ownerModule = name
                    this.skipTrivia()
                } else {
                    // Not an ownership declaration — restore and parse normally.
                    this.pos = saved
                }
            } else {
                this.pos = saved
            }
        }

        const nodes: TopLevelNode[] = []

        while (!this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.EOF)) break

            const savedPos = this.pos
            const node = this.parseTopLevel()
            if (node !== null) {
                nodes.push(node)
            } else if (this.pos === savedPos) {
                // parseTopLevel returned null without advancing (e.g. synchronise()
                // stopped at an RParen that has no matching open at the top level).
                // Force progress to prevent an infinite loop.
                this.advance()
            }
        }

        return { kind: 'Document', ownerModule, nodes }
    }

    // ── Top-level dispatch ─────────────────────────────────────────────────────

    /**
     * Parses one top-level construct and returns it, or emits a diagnostic
     * and returns null if the current token does not start a known construct.
     */
    private parseTopLevel(): TopLevelNode | null {
        const tok = this.current()

        switch (tok.type) {
            case TokenType.System: return this.parseSystem()
            case TokenType.Module: return this.parseModule()
            case TokenType.State: return this.parseState()
            case TokenType.Context: return this.parseContext()
            case TokenType.Screen: return this.parseScreen()
            case TokenType.View: return this.parseView()
            case TokenType.Provider: return this.parseProvider()
            case TokenType.Adapter: return this.parseAdapter()
            case TokenType.Interface: return this.parseInterface()
            default:
                this.error(
                    DiagnosticCode.P_INVALID_CONSTRUCT_POSITION,
                    `Unexpected token '${tok.value}' — expected a construct keyword (system, module, state, context, screen, view, provider, adapter, interface)`,
                    tok
                )
                this.synchronise()
                return null
        }
    }

    // ── System ─────────────────────────────────────────────────────────────────

    /**
     * Parses:
     *   system SystemName "description" (
     *     modules ( ModuleOne ModuleTwo )
     *     interface ( ... )
     *   )
     */
    private parseSystem(): SystemNode {
        const tok = this.expect(TokenType.System)!
        this.skipTrivia()
        const name = this.expectIdent('system name')
        this.skipTrivia()
        const description = this.parseOptionalString()
        this.skipTrivia()
        this.expect(TokenType.LParen)

        const modules: string[] = []
        const interfaceMethods: MethodNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.Modules)) {
                this.advance()
                this.skipTrivia()
                this.expect(TokenType.LParen)
                while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
                    this.skipTrivia()
                    if (this.check(TokenType.PascalIdent)) {
                        modules.push(this.advance().value)
                    } else if (!this.check(TokenType.RParen)) {
                        this.error(DiagnosticCode.P_MISSING_IDENTIFIER, `Expected module name`, this.current())
                        this.advance()
                    }
                }
                this.expect(TokenType.RParen)
            } else if (this.check(TokenType.Interface)) {
                this.advance()
                this.skipTrivia()
                this.expect(TokenType.LParen)
                while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
                    this.skipTrivia()
                    if (this.check(TokenType.CamelIdent)) {
                        interfaceMethods.push(this.parseMethod())
                    } else if (!this.check(TokenType.RParen)) {
                        this.advance()
                    }
                }
                this.expect(TokenType.RParen)
            } else if (!this.check(TokenType.RParen)) {
                this.advance()
            }
        }

        this.expect(TokenType.RParen)
        return { kind: 'System', token: tok, name, description, modules, interfaceMethods }
    }

    // ── Module ─────────────────────────────────────────────────────────────────

    /**
     * Parses:
     *   module ModuleName "description" (
     *     process ... ( when ... )
     *     start StateName
     *     implements Module.Handler ( methodName param(Type) ( if ... ) )
     *     system.Module.subscribeRoute ...
     *     interface HandlerName ( ... )
     *   )
     */
    private parseModule(): ModuleNode {
        const tok = this.expect(TokenType.Module)!
        this.skipTrivia()
        const name = this.expectIdent('module name')
        this.skipTrivia()
        const description = this.parseOptionalString()
        this.skipTrivia()
        this.expect(TokenType.LParen)

        const processes: ProcessNode[] = []
        let startState: string | null = null
        const implementations: (ImplementsHandlerNode | ImplementsCallbackNode)[] = []
        const subscriptions: CallExpressionNode[] = []
        const inlineInterfaces: InterfaceNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.Process)) {
                processes.push(this.parseProcess())
            } else if (this.check(TokenType.Start)) {
                this.advance()
                this.skipTrivia()
                startState = this.expectIdent('start state name')
            } else if (this.check(TokenType.Implements)) {
                implementations.push(this.parseImplements())
            } else if (this.check(TokenType.Interface)) {
                inlineInterfaces.push(this.parseInterface())
            } else if (this.checkSystemCall()) {
                subscriptions.push(this.parseSystemCall())
            } else if (!this.check(TokenType.RParen)) {
                this.advance()
            }
        }

        this.expect(TokenType.RParen)
        return {
            kind: 'Module', token: tok, name, description,
            processes, startState,
            implements: implementations,
            subscriptions, inlineInterfaces,
        }
    }

    // ── Process ────────────────────────────────────────────────────────────────

    /**
     * Parses:
     *   process ProcessName "description" (
     *     when State returns Context
     *       enter NextState "narrative"
     *     ...
     *   )
     */
    private parseProcess(): ProcessNode {
        const tok = this.expect(TokenType.Process)!
        this.skipTrivia()
        const name = this.expectIdent('process name')
        this.skipTrivia()
        const description = this.parseOptionalString()
        this.skipTrivia()
        this.expect(TokenType.LParen)

        const rules: WhenRuleNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.When)) {
                rules.push(this.parseWhenRule())
            } else if (!this.check(TokenType.RParen)) {
                this.advance()
            }
        }

        this.expect(TokenType.RParen)
        return { kind: 'Process', token: tok, name, description, rules }
    }

    /**
     * Parses:
     *   when CurrentState returns ProducedContext
     *     enter NextState "narrative" ( inlineContext? )
     */
    private parseWhenRule(): WhenRuleNode {
        const tok = this.expect(TokenType.When)!
        this.skipTrivia()
        const currentState = this.expectIdent('state name in when rule')
        this.skipTrivia()

        if (!this.check(TokenType.Returns)) {
            this.error(DiagnosticCode.P_MISSING_RETURNS, `Expected 'returns' in when rule`, this.current())
        } else {
            this.advance()
        }

        this.skipTrivia()
        const producedContext = this.expectIdent('context name in when rule')
        this.skipTrivia()

        if (!this.check(TokenType.Enter)) {
            this.error(DiagnosticCode.P_MISSING_ENTER, `Expected 'enter' in when rule`, this.current())
        } else {
            this.advance()
        }

        this.skipTrivia()
        const nextState = this.expectIdent('next state name in when rule')
        this.skipTrivia()
        const narrative = this.parseOptionalString()
        this.skipTrivia()

        // Optional inline context construction block
        let inlineContext: InlineContextNode | null = null
        if (this.check(TokenType.LParen)) {
            inlineContext = this.parseInlineContext()
        }

        return { kind: 'WhenRule', token: tok, currentState, producedContext, nextState, narrative, inlineContext }
    }

    /**
     * Parses an inline context construction block:
     *   ( reason is "..." code is "..." )
     */
    private parseInlineContext(): InlineContextNode {
        const tok = this.expect(TokenType.LParen)!
        const args = this.parseArguments()
        this.expect(TokenType.RParen)
        return { kind: 'InlineContext', token: tok, args }
    }

    // ── Implements ─────────────────────────────────────────────────────────────

    /**
     * Dispatches to either the switch-handler form or the callback form:
     *
     * Switch form (if-branch dispatch):
     *   implements Module.HandlerInterface (
     *     methodName param(Type) (
     *       if param is "/path"
     *         enter State "narrative"
     *     )
     *   )
     *
     * Callback form (direct enter action):
     *   implements Module.ListenerInterface (
     *     methodName is (
     *       enter State context is ContextType ( args )
     *     )
     *   )
     *
     * The form is detected by checking whether `is` follows the method name.
     */
    private parseImplements(): ImplementsHandlerNode | ImplementsCallbackNode {
        const tok = this.expect(TokenType.Implements)!
        this.skipTrivia()
        const interfaceName = this.parseQualifiedName()
        this.skipTrivia()
        this.expect(TokenType.LParen)
        this.skipTrivia()

        const methodName = this.expectIdent('method name')
        this.skipTrivia()

        if (this.check(TokenType.Is)) {
            return this.parseImplementsCallbackBody(tok, interfaceName, methodName)
        }

        // Switch form: methodName paramName(Type) ( if ... )
        const switchParam = this.expectIdent('handler method parameter name')
        this.skipTrivia()
        this.expect(TokenType.LParen)
        const switchParamType = this.parseType()
        this.expect(TokenType.RParen)
        this.skipTrivia()
        this.expect(TokenType.LParen)

        const branches: ImplementsBranchNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.If)) {
                branches.push(this.parseImplementsBranch())
            } else if (!this.check(TokenType.RParen)) {
                this.advance()
            }
        }

        this.expect(TokenType.RParen) // close method body
        this.skipTrivia()
        this.expect(TokenType.RParen) // close implements body

        return { kind: 'ImplementsHandler', token: tok, interfaceName, switchParam, switchParamType, branches }
    }

    /**
     * Parses the callback form of an implements body:
     *   methodName is (
     *     enter State context is ContextType ( args )
     *   )
     */
    private parseImplementsCallbackBody(
        tok: Token,
        interfaceName: QualifiedName,
        methodName: string
    ): ImplementsCallbackNode {
        this.advance() // consume 'is'
        this.skipTrivia()
        this.expect(TokenType.LParen) // open method body

        const enterActions: ImplementsEnterActionNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.Enter)) {
                enterActions.push(this.parseImplementsEnterAction())
            } else if (!this.check(TokenType.RParen)) {
                this.advance()
            }
        }

        this.expect(TokenType.RParen) // close method body
        this.skipTrivia()
        this.expect(TokenType.RParen) // close implements body

        return { kind: 'ImplementsCallback', token: tok, interfaceName, methodName, enterActions }
    }

    /**
     * Parses a single enter action inside an implements callback body:
     *   enter StateName context is ContextType ( field is value, ... )
     */
    private parseImplementsEnterAction(): ImplementsEnterActionNode {
        const tok = this.expect(TokenType.Enter)!
        this.skipTrivia()
        const targetState = this.expectIdent('target state name')
        this.skipTrivia()

        let contextType: string | null = null
        if (this.check(TokenType.Context)) {
            this.advance() // consume 'context'
            this.skipTrivia()
            this.expect(TokenType.Is)
            this.skipTrivia()
            contextType = this.expectIdent('context type name')
            this.skipTrivia()
        }

        let inlineContext: InlineContextNode | null = null
        if (this.check(TokenType.LParen)) {
            inlineContext = this.parseInlineContext()
        }

        return { kind: 'ImplementsEnterAction', token: tok, targetState, contextType, inlineContext }
    }

    /**
     * Parses one branch inside an implements switch handler body:
     *   if param is "/path"
     *     enter State "narrative"
     */
    private parseImplementsBranch(): ImplementsBranchNode {
        const tok = this.expect(TokenType.If)!
        this.skipTrivia()
        const condition = this.parseCondition()
        this.skipTrivia()
        this.expect(TokenType.Enter)
        this.skipTrivia()
        const targetState = this.expectIdent('target state name')
        this.skipTrivia()
        const narrative = this.parseOptionalString()
        return { kind: 'ImplementsBranch', token: tok, condition, targetState, narrative }
    }

    // ── State ──────────────────────────────────────────────────────────────────

    /**
     * Parses:
     *   state StateName receives ?ContextName (
     *     returns ContextA, ContextB
     *     uses screen ScreenName
     *   )
     */
    private parseState(): StateNode {
        const tok = this.expect(TokenType.State)!
        this.skipTrivia()
        const name = this.expectIdent('state name')
        this.skipTrivia()
        this.parseOptionalString()
        this.skipTrivia()

        // Optional receives clause
        let receives: string | null = null
        let receivesOptional = false
        if (this.check(TokenType.Receives)) {
            this.advance()
            this.skipTrivia()
            if (this.check(TokenType.Question)) {
                receivesOptional = true
                this.advance()
            }
            receives = this.expectIdent('context name in receives clause')
            this.skipTrivia()
        }

        this.expect(TokenType.LParen)

        let returns: ReturnsNode | null = null
        const uses: UseEntryNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.Returns)) {
                returns = this.parseReturns()
            } else if (this.check(TokenType.Uses)) {
                uses.push(...this.parseUsesBlock())
            } else if (!this.check(TokenType.RParen)) {
                this.advance()
            }
        }

        this.expect(TokenType.RParen)
        return { kind: 'State', token: tok, module: '', name, receives, receivesOptional, returns, uses }
    }

    // ── Context ────────────────────────────────────────────────────────────────

    /**
     * Parses:
     *   context ContextName (
     *     field(Type),
     *     field(Type)
     *   )
     */
    private parseContext(): ContextNode {
        const tok = this.expect(TokenType.Context)!
        this.skipTrivia()
        const name = this.expectIdent('context name')
        this.skipTrivia()
        this.parseOptionalString()
        this.skipTrivia()
        this.expect(TokenType.LParen)
        const fields = this.parsePropList()
        this.expect(TokenType.RParen)
        return { kind: 'Context', token: tok, module: '', name, fields }
    }

    // ── Screen ─────────────────────────────────────────────────────────────────

    /**
     * Parses:
     *   screen ScreenName "description" (
     *     uses ( ... )
     *   )
     */
    private parseScreen(): ScreenNode {
        const tok = this.expect(TokenType.Screen)!
        this.skipTrivia()
        const name = this.expectIdent('screen name')
        this.skipTrivia()
        const description = this.parseOptionalString()
        this.skipTrivia()
        this.expect(TokenType.LParen)

        const uses: UseEntryNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.Uses)) {
                uses.push(...this.parseUsesBlock())
            } else if (!this.check(TokenType.RParen)) {
                this.advance()
            }
        }

        this.expect(TokenType.RParen)
        return { kind: 'Screen', token: tok, module: '', name, description, uses }
    }

    // ── View ───────────────────────────────────────────────────────────────────

    /**
     * Parses:
     *   view ViewName "description" (
     *     props ( ... )
     *     state ( ... )
     *     uses ( ... )
     *   )
     */
    private parseView(): ViewNode {
        const tok = this.expect(TokenType.View)!
        this.skipTrivia()
        const name = this.expectIdent('view name')
        this.skipTrivia()
        const description = this.parseOptionalString()
        this.skipTrivia()
        this.expect(TokenType.LParen)

        let props: PropNode[] = []
        let stateFields: PropNode[] = []
        const uses: UseEntryNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.Props)) {
                this.advance(); this.skipTrivia()
                this.expect(TokenType.LParen)
                props = this.parsePropList()
                this.expect(TokenType.RParen)
            } else if (this.check(TokenType.State)) {
                this.advance(); this.skipTrivia()
                this.expect(TokenType.LParen)
                stateFields = this.parsePropList()
                this.expect(TokenType.RParen)
            } else if (this.check(TokenType.Uses)) {
                uses.push(...this.parseUsesBlock())
            } else if (!this.check(TokenType.RParen)) {
                this.advance()
            }
        }

        this.expect(TokenType.RParen)
        return { kind: 'View', token: tok, module: '', name, description, props, state: stateFields, uses }
    }

    // ── Provider ───────────────────────────────────────────────────────────────

    /**
     * Parses:
     *   provider ProviderName "description" (
     *     props ( ... )
     *     state ( ... )
     *     interface ( methods... )
     *   )
     */
    private parseProvider(): ProviderNode {
        const tok = this.expect(TokenType.Provider)!
        this.skipTrivia()
        const name = this.expectIdent('provider name')
        this.skipTrivia()
        const description = this.parseOptionalString()
        this.skipTrivia()
        this.expect(TokenType.LParen)

        let props: PropNode[] = []
        let stateFields: PropNode[] = []
        const methods: MethodNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.Props)) {
                this.advance(); this.skipTrivia()
                this.expect(TokenType.LParen)
                props = this.parsePropList()
                this.expect(TokenType.RParen)
            } else if (this.check(TokenType.State)) {
                this.advance(); this.skipTrivia()
                this.expect(TokenType.LParen)
                stateFields = this.parsePropList()
                this.expect(TokenType.RParen)
            } else if (this.check(TokenType.Interface)) {
                this.advance(); this.skipTrivia()
                this.expect(TokenType.LParen)
                while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
                    this.skipTrivia()
                    if (this.check(TokenType.CamelIdent)) {
                        methods.push(this.parseMethod())
                    } else if (!this.check(TokenType.RParen)) {
                        this.advance()
                    }
                }
                this.expect(TokenType.RParen)
            } else if (!this.check(TokenType.RParen)) {
                this.advance()
            }
        }

        this.expect(TokenType.RParen)
        return { kind: 'Provider', token: tok, module: '', name, description, props, state: stateFields, methods }
    }

    // ── Adapter ────────────────────────────────────────────────────────────────

    /**
     * Parses:
     *   adapter AdapterName "description" (
     *     props ( ... )
     *     state ( ... )
     *     interface ( methods... )
     *   )
     */
    private parseAdapter(): AdapterNode {
        const tok = this.expect(TokenType.Adapter)!
        this.skipTrivia()
        const name = this.expectIdent('adapter name')
        this.skipTrivia()
        const description = this.parseOptionalString()
        this.skipTrivia()
        this.expect(TokenType.LParen)

        let props: PropNode[] = []
        let stateFields: PropNode[] = []
        const methods: MethodNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.Props)) {
                this.advance(); this.skipTrivia()
                this.expect(TokenType.LParen)
                props = this.parsePropList()
                this.expect(TokenType.RParen)
            } else if (this.check(TokenType.State)) {
                this.advance(); this.skipTrivia()
                this.expect(TokenType.LParen)
                stateFields = this.parsePropList()
                this.expect(TokenType.RParen)
            } else if (this.check(TokenType.Interface)) {
                this.advance(); this.skipTrivia()
                this.expect(TokenType.LParen)
                while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
                    this.skipTrivia()
                    if (this.check(TokenType.CamelIdent)) {
                        methods.push(this.parseMethod())
                    } else if (!this.check(TokenType.RParen)) {
                        this.advance()
                    }
                }
                this.expect(TokenType.RParen)
            } else if (!this.check(TokenType.RParen)) {
                this.advance()
            }
        }

        this.expect(TokenType.RParen)
        return { kind: 'Adapter', token: tok, module: '', name, description, props, state: stateFields, methods }
    }

    // ── Interface ──────────────────────────────────────────────────────────────

    /**
     * Parses:
     *   interface InterfaceName "description" (
     *     props ( ... )
     *     state ( ... )
     *     uses ( ... )
     *     methodName param(Type) returns(Type) "description"
     *     ...
     *   )
     *
     * When used as a module-level handler interface, the body contains a
     * method declaration whose body is a series of `if` branches. The method
     * name (e.g. `switch`) is a plain camelCase identifier — not a keyword.
     */
    private parseInterface(): InterfaceNode {
        const tok = this.expect(TokenType.Interface)!
        this.skipTrivia()
        // Name is optional — a module-level anonymous interface (`interface ( ... )`)
        // exposes methods directly without a named handler shape.
        const name = this.check(TokenType.LParen) ? '' : this.expectIdent('interface name')
        this.skipTrivia()
        const description = this.parseOptionalString()
        this.skipTrivia()
        this.expect(TokenType.LParen)

        let props: PropNode[] = []
        let stateFields: PropNode[] = []
        const methods: MethodNode[] = []
        const uses: UseEntryNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.Props)) {
                this.advance(); this.skipTrivia()
                this.expect(TokenType.LParen)
                props = this.parsePropList()
                this.expect(TokenType.RParen)
            } else if (this.check(TokenType.State)) {
                this.advance(); this.skipTrivia()
                this.expect(TokenType.LParen)
                stateFields = this.parsePropList()
                this.expect(TokenType.RParen)
            } else if (this.check(TokenType.Uses)) {
                uses.push(...this.parseUsesBlock())
            } else if (this.check(TokenType.CamelIdent)) {
                // Methods appear directly in the body after props.
                // This includes handler interface method declarations whose body
                // contains if-branches (e.g. `switch path(string) ( if ... )`).
                methods.push(this.parseInterfaceMethod())
            } else if (!this.check(TokenType.RParen)) {
                this.advance()
            }
        }

        this.expect(TokenType.RParen)
        return { kind: 'Interface', token: tok, module: '', name, description, props, state: stateFields, methods, uses }
    }

    // ── Returns clause ─────────────────────────────────────────────────────────

    /**
     * Parses either the simple or expanded form of a returns clause.
     *
     * Simple:   returns ContextA, ContextB
     * Expanded: returns ( ContextA ( sideEffects ) ContextB ( sideEffects ) )
     */
    private parseReturns(): ReturnsNode {
        const tok = this.expect(TokenType.Returns)!
        this.skipTrivia()

        // Expanded form starts with '('
        if (this.check(TokenType.LParen)) {
            this.advance()
            const entries: ExpandedReturnNode[] = []

            while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
                this.skipTrivia()
                if (this.check(TokenType.PascalIdent)) {
                    const ctxTok = this.current()
                    const contextName = this.advance().value
                    this.skipTrivia()
                    const sideEffects: SideEffectNode[] = []
                    if (this.check(TokenType.LParen)) {
                        this.advance()
                        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
                            this.skipTrivia()
                            if (this.checkSystemCall()) {
                                const callTok = this.current()
                                const call = this.parseQualifiedName()
                                this.skipTrivia()
                                const args = this.parseInlineArgList()
                                sideEffects.push({ kind: 'SideEffect', token: callTok, call, args })
                            } else if (!this.check(TokenType.RParen)) {
                                this.advance()
                            }
                        }
                        this.expect(TokenType.RParen)
                    }
                    entries.push({ kind: 'ExpandedReturn', token: ctxTok, contextName, sideEffects })
                } else if (!this.check(TokenType.RParen)) {
                    this.advance()
                }
            }

            this.expect(TokenType.RParen)
            return { kind: 'ExpandedReturns', token: tok, entries } as ExpandedReturnsNode
        }

        // Simple form — comma-separated list of context names
        const contexts: string[] = []
        const contextTokens: import('../lexer/token').Token[] = []
        if (this.check(TokenType.PascalIdent)) {
            contextTokens.push(this.current())
            contexts.push(this.advance().value)
            while (this.check(TokenType.Comma)) {
                this.advance()
                this.skipTrivia()
                if (this.check(TokenType.PascalIdent)) {
                    contextTokens.push(this.current())
                    contexts.push(this.advance().value)
                }
            }
        }

        return { kind: 'SimpleReturns', token: tok, contexts, contextTokens } as SimpleReturnsNode
    }

    // ── Uses block ─────────────────────────────────────────────────────────────

    /**
     * Parses a `uses` block and returns its entries.
     * Handles both the single-entry form and the parenthesised list form.
     *
     * Single: `uses screen LoginScreen`
     * List:   `uses ( view A, view B, if ... )`
     */
    private parseUsesBlock(): UseEntryNode[] {
        this.expect(TokenType.Uses)
        this.skipTrivia()

        if (this.check(TokenType.LParen)) {
            this.advance()
            const entries = this.parseUseEntries()
            this.expect(TokenType.RParen)
            return entries
        }

        // Single entry without parentheses
        const entry = this.parseUseEntry()
        return entry ? [entry] : []
    }

    /**
     * Parses a comma-separated sequence of use entries inside a `uses ( ... )` block.
     */
    private parseUseEntries(): UseEntryNode[] {
        const entries: UseEntryNode[] = []
        let lastPos = -1
        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            if (this.pos === lastPos) { this.advance(); continue }
            lastPos = this.pos
            this.skipTrivia()
            if (this.check(TokenType.RParen)) break
            const entry = this.parseUseEntry()
            if (entry) entries.push(entry)
            this.skipTrivia()
            if (this.check(TokenType.Comma)) this.advance()
        }
        return entries
    }

    /**
     * Parses a single use entry — a component use, a system call, a conditional
     * block, or an iteration block.
     */
    private parseUseEntry(): UseEntryNode | null {
        this.skipTrivia()
        const tok = this.current()

        if (this.check(TokenType.If)) return this.parseConditionalBlock()
        if (this.check(TokenType.For)) return this.parseIterationBlock()
        if (this.checkSystemCall()) return this.parseSystemCall()

        // Component kinds: screen, view, adapter, provider, interface
        if (
            this.check(TokenType.Screen) ||
            this.check(TokenType.View) ||
            this.check(TokenType.Adapter) ||
            this.check(TokenType.Provider) ||
            this.check(TokenType.Interface)
        ) {
            return this.parseComponentUse()
        }

        this.error(
            DiagnosticCode.P_INVALID_CONSTRUCT_POSITION,
            `Unexpected token '${tok.value}' inside uses block`,
            tok
        )
        this.advance()
        return null
    }

    /**
     * Parses a single component use:
     *   view UIModule.LoginForm ( args... uses... )
     *   adapter SessionAdapter.checkSession
     *   screen LoginScreen
     */
    private parseComponentUse(): ComponentUseNode {
        const tok = this.current()
        const componentKind = tok.value as ComponentUseNode['componentKind']
        this.advance()
        this.skipTrivia()

        const name = this.parseQualifiedName()
        this.skipTrivia()

        const args: ArgumentNode[] = []
        const uses: UseEntryNode[] = []

        // Arguments and nested uses can appear either inline or in a paren block
        if (this.check(TokenType.LParen)) {
            this.advance()
            // Inside the paren block: arguments and nested use entries
            while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
                this.skipTrivia()
                if (this.check(TokenType.Uses)) {
                    uses.push(...this.parseUsesBlock())
                } else if (this.checkArgumentStart()) {
                    args.push(...this.parseArguments())
                } else if (this.isUseEntry()) {
                    const entry = this.parseUseEntry()
                    if (entry) uses.push(entry)
                } else if (!this.check(TokenType.RParen)) {
                    this.advance()
                }
            }
            this.expect(TokenType.RParen)
        } else {
            // Inline arguments without parens: adapter X key is value, key is value
            // Also handles a leading comma before the first arg:
            //   adapter X, key is value, key2 is value2
            // Consume the comma only when what follows (past trivia) is an argument
            // start (CamelIdent), not a new use-entry keyword or closing token.
            if (this.check(TokenType.Comma) && this.peekPastTriviaIsCamelIdent()) {
                this.advance() // consume the leading comma
                this.skipTrivia()
            }
            if (this.checkArgumentStart()) {
                args.push(...this.parseInlineArgList())
            }
        }

        return { kind: 'ComponentUse', token: tok, componentKind, name, args, uses }
    }

    /**
     * Parses:
     *   if condition ( useEntries... )
     */
    private parseConditionalBlock(): ConditionalBlockNode {
        const tok = this.expect(TokenType.If)!
        this.skipTrivia()
        const condition = this.parseCondition()
        this.skipTrivia()
        this.expect(TokenType.LParen)
        const body = this.parseUseEntries()
        this.expect(TokenType.RParen)
        return { kind: 'ConditionalBlock', token: tok, condition, body }
    }

    /**
     * Parses:
     *   for collection as binding ( useEntries... )
     *   for collection as key, value ( useEntries... )
     */
    private parseIterationBlock(): IterationBlockNode {
        const tok = this.expect(TokenType.For)!
        this.skipTrivia()
        const collection = this.parseAccessExpression()
        this.skipTrivia()
        this.expect(TokenType.As)
        this.skipTrivia()

        const bindings: string[] = []
        bindings.push(this.expectIdent('iteration binding'))
        this.skipTrivia()
        // Map iteration: two bindings separated by comma
        if (this.check(TokenType.Comma)) {
            this.advance()
            this.skipTrivia()
            bindings.push(this.expectIdent('second iteration binding'))
            this.skipTrivia()
        }

        this.expect(TokenType.LParen)
        const body = this.parseUseEntries()
        this.expect(TokenType.RParen)
        return { kind: 'IterationBlock', token: tok, collection, bindings, body }
    }

    // ── Condition ──────────────────────────────────────────────────────────────

    /**
     * Parses a condition expression:
     *   state.context is AccountDeauthenticated
     *   state.context.status is "pending"
     *   state.context is not AccountRecovered
     */
    private parseCondition(): ConditionNode {
        const tok = this.current()
        const left = this.parseAccessExpression()
        this.skipTrivia()

        let operator: 'is' | 'is not' = 'is'
        if (this.check(TokenType.IsNot)) {
            operator = 'is not'
            this.advance()
        } else if (this.check(TokenType.Is)) {
            this.advance()
        } else {
            this.error(DiagnosticCode.P_MISSING_IS, `Expected 'is' or 'is not' in condition`, this.current())
        }

        this.skipTrivia()
        const right = this.parseExpression()
        return { kind: 'Condition', token: tok, left, operator, right }
    }

    // ── Arguments ──────────────────────────────────────────────────────────────

    /**
     * Parses a comma-separated list of `name is value` arguments.
     * Used inside parenthesised component use bodies and system calls.
     */
    private parseArguments(): ArgumentNode[] {
        const args: ArgumentNode[] = []
        let lastPos = -1
        this.skipTrivia() // allow arguments to start on the next line after '('
        while (this.checkArgumentStart()) {
            if (this.pos === lastPos) break
            lastPos = this.pos
            args.push(this.parseArgument())
            this.skipTrivia()
            if (this.check(TokenType.Comma)) this.advance()
            this.skipTrivia()
        }
        return args
    }

    /**
     * Parses a comma-separated list of inline `name is value` arguments
     * without an enclosing paren block. Stops at newline, `)`, or EOF.
     */
    private parseInlineArgList(): ArgumentNode[] {
        const args: ArgumentNode[] = []
        while (this.checkArgumentStart()) {
            args.push(this.parseArgument())
            this.skipTrivia()
            if (this.check(TokenType.Comma)) {
                this.advance()
                this.skipTrivia()
            } else {
                break
            }
        }
        return args
    }

    /**
     * Parses a single argument: `name is value`
     */
    private parseArgument(): ArgumentNode {
        const tok = this.current()
        const name = this.expectIdent('argument name')
        this.skipTrivia()
        if (!this.check(TokenType.Is)) {
            this.error(DiagnosticCode.P_MISSING_IS, `Expected 'is' after argument name '${name}'`, this.current())
        } else {
            this.advance()
        }
        this.skipTrivia()
        const value = this.parseExpression()
        return { kind: 'Argument', token: tok, name, value }
    }

    // ── Expressions ────────────────────────────────────────────────────────────

    /**
     * Parses an expression — a value on the right-hand side of an `is` assignment
     * or a condition operand.
     *
     * Handles:
     *   - Block expressions:          `( state.return(x) )`
     *   - state.return():             `state.return(contextName)`
     *   - Access expressions:         `state.context.fullName`, `props.items`
     *   - Call expressions:           `system.getContext(SystemUser)`
     *   - Literals:                   `"string"`, `42`, `3.14`, `true`, `false`, `[]`, `{}`
     *   - PascalCase type references: `SystemUser` (e.g. in system.getContext(SystemUser))
     */
    private parseExpression(): ExpressionNode {
        const tok = this.current()

        // Block expression: ( ... )
        if (this.check(TokenType.LParen)) {
            return this.parseBlockExpression()
        }

        // Literals
        if (this.check(TokenType.StringLit)) return this.parseStringLiteral()
        if (this.check(TokenType.IntegerLit)) return this.parseIntegerLiteral()
        if (this.check(TokenType.FloatLit)) return this.parseFloatLiteral()
        if (this.check(TokenType.BooleanLit)) return this.parseBooleanLiteral()
        if (this.checkListLiteral()) return this.parseListLiteral()
        if (this.checkMapLiteral()) return this.parseMapLiteral()

        // PascalCase identifier — type reference as argument value
        // e.g. system.getContext(SystemUser)
        if (this.check(TokenType.PascalIdent)) {
            return {
                kind: 'AccessExpression',
                token: tok,
                path: [this.advance().value],
            } as AccessExpressionNode
        }

        // Access expression or call expression starting with a camelCase name,
        // 'state', or 'system'
        if (
            this.check(TokenType.CamelIdent) ||
            this.check(TokenType.State) ||
            this.check(TokenType.System) ||
            this.check(TokenType.Props)
        ) {
            return this.parseAccessOrCall()
        }

        // Fallback — emit error and return a dummy access expression
        this.error(
            DiagnosticCode.P_UNEXPECTED_TOKEN,
            `Unexpected token '${tok.value}' in expression`,
            tok
        )
        this.advance()
        return { kind: 'AccessExpression', token: tok, path: ['?'] } as AccessExpressionNode
    }

    /**
     * Parses a block expression: `( statements... )`
     * The body contains either state.return() calls or assignment statements.
     */
    private parseBlockExpression(): BlockExpressionNode {
        const tok = this.expect(TokenType.LParen)!
        const statements: StatementNode[] = []

        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.RParen)) break

            const stmt = this.parseStatement()
            if (stmt) statements.push(stmt)
            this.skipTrivia()
        }

        this.expect(TokenType.RParen)
        return { kind: 'BlockExpression', token: tok, statements }
    }

    /**
     * Parses a statement inside a block expression body.
     *
     * `state.return(contextName)` → StateReturnStatement
     * `state.fieldName is value`  → AssignmentStatement
     */
    private parseStatement(): StatementNode | null {
        const tok = this.current()

        if (this.check(TokenType.State)) {
            this.advance() // consume 'state'
            this.skipTrivia()
            this.expect(TokenType.Dot)
            this.skipTrivia()

            // state.return ContextType ( args )  — new form
            // state.return(contextName)           — old form
            if (this.check(TokenType.CamelIdent) && this.current().value === 'return') {
                this.advance() // consume 'return'
                this.skipTrivia()

                // New form: state.return ContextType [( inlineArgs )]
                if (this.check(TokenType.PascalIdent)) {
                    const contextNameToken = this.current()
                    const contextName = this.advance().value
                    this.skipTrivia()
                    let inlineContext: InlineContextNode | null = null
                    if (this.check(TokenType.LParen)) {
                        inlineContext = this.parseInlineContext()
                    }
                    return { kind: 'StateReturnStatement', token: tok, contextName, contextNameToken, inlineContext } as StateReturnStatementNode
                }

                // Old form: state.return(contextName)
                this.expect(TokenType.LParen)
                this.skipTrivia()
                const contextNameToken = this.current()
                const contextName = this.expectIdent('context name in state.return()')
                this.skipTrivia()
                this.expect(TokenType.RParen)
                return { kind: 'StateReturnStatement', token: tok, contextName, contextNameToken, inlineContext: null } as StateReturnStatementNode
            }

            // state.fieldName is value — assignment
            const fieldName = this.expectIdent('state field name')
            this.skipTrivia()
            this.expect(TokenType.Is)
            this.skipTrivia()
            const value = this.parseExpression()
            const target: AccessExpressionNode = { kind: 'AccessExpression', token: tok, path: ['state', fieldName] }
            return { kind: 'AssignmentStatement', token: tok, target, value } as AssignmentStatementNode
        }

        // Unknown statement — skip
        this.error(DiagnosticCode.P_UNEXPECTED_TOKEN, `Unexpected token '${tok.value}' in block`, tok)
        this.advance()
        return null
    }

    /**
     * Parses an access expression or call expression starting with a camelCase
     * name, 'state', or 'system'.
     *
     * If the path ends with `(...)`, it becomes a CallExpression.
     * If the path ends with `return(...)`, it becomes a StateReturnExpression.
     */
    private parseAccessOrCall(): ExpressionNode {
        const tok = this.current()
        const path: string[] = []

        // Consume the first segment
        path.push(this.advance().value)

        // Follow dot-separated segments
        while (this.check(TokenType.Dot)) {
            this.advance() // consume '.'
            if (
                this.check(TokenType.CamelIdent) ||
                this.check(TokenType.PascalIdent) ||
                this.check(TokenType.State) ||
                this.check(TokenType.System) ||
                this.check(TokenType.Context) ||
                this.check(TokenType.Props) ||
                this.check(TokenType.Returns)
            ) {
                path.push(this.advance().value)
            } else {
                break
            }
        }

        // state.return(contextName) — special form
        if (path[0] === 'state' && path[1] === 'return' && this.check(TokenType.LParen)) {
            this.advance() // consume '('
            this.skipTrivia()
            const contextName = this.expectIdent('context name in state.return()')
            this.skipTrivia()
            this.expect(TokenType.RParen)
            return { kind: 'StateReturnExpression', token: tok, contextName } as StateReturnExpressionNode
        }

        // Call expression: path(args...)
        // Supports both keyword-style args (`name is value`) and a single positional
        // PascalIdent type reference (e.g. `system.getContext(SystemUser)`).
        // After the closing ')' may come further dot-segments: `.fullName`, `.avatarUrl`, etc.
        if (this.check(TokenType.LParen)) {
            this.advance() // consume '('
            const args = this.parseArguments()
            if (args.length === 0 && this.check(TokenType.PascalIdent)) {
                const valTok = this.current()
                const valName = this.advance().value
                const value: AccessExpressionNode = { kind: 'AccessExpression', token: valTok, path: [valName] }
                args.push({ kind: 'Argument', token: valTok, name: '', value })
            }
            this.expect(TokenType.RParen)
            // Consume any trailing property access: system.getContext(SystemUser).fullName
            while (this.check(TokenType.Dot)) {
                this.advance()
                if (
                    this.check(TokenType.CamelIdent) ||
                    this.check(TokenType.PascalIdent) ||
                    this.check(TokenType.Context)
                ) {
                    path.push(this.advance().value)
                } else {
                    break
                }
            }
            const callee: AccessExpressionNode = { kind: 'AccessExpression', token: tok, path }
            return { kind: 'CallExpression', token: tok, callee, args } as CallExpressionNode
        }

        // Plain access expression
        return { kind: 'AccessExpression', token: tok, path } as AccessExpressionNode
    }

    /**
     * Parses a dot-separated access path — always returns an AccessExpressionNode.
     * Used in conditions and iteration blocks where a call is not expected.
     */
    private parseAccessExpression(): AccessExpressionNode {
        const tok = this.current()
        const path: string[] = []

        path.push(this.advance().value)

        while (this.check(TokenType.Dot)) {
            this.advance()
            if (
                this.check(TokenType.CamelIdent) ||
                this.check(TokenType.PascalIdent) ||
                this.check(TokenType.State) ||
                this.check(TokenType.System) ||
                this.check(TokenType.Context) ||
                this.check(TokenType.Props)
            ) {
                path.push(this.advance().value)
            } else {
                break
            }
        }

        return { kind: 'AccessExpression', token: tok, path }
    }

    // ── Literals ───────────────────────────────────────────────────────────────

    private parseStringLiteral(): StringLiteralNode {
        const tok = this.advance()
        // Strip surrounding quotes from the raw token value
        const value = tok.value.slice(1, -1)
        return { kind: 'StringLiteral', token: tok, value }
    }

    private parseIntegerLiteral(): IntegerLiteralNode {
        const tok = this.advance()
        return { kind: 'IntegerLiteral', token: tok, value: parseInt(tok.value, 10) }
    }

    private parseFloatLiteral(): FloatLiteralNode {
        const tok = this.advance()
        return { kind: 'FloatLiteral', token: tok, value: parseFloat(tok.value) }
    }

    private parseBooleanLiteral(): BooleanLiteralNode {
        const tok = this.advance()
        return { kind: 'BooleanLiteral', token: tok, value: tok.value === 'true' }
    }

    private parseListLiteral(): ListLiteralNode {
        const tok = this.current()
        this.advance() // '['
        this.advance() // ']'
        return { kind: 'ListLiteral', token: tok, elements: [] }
    }

    private parseMapLiteral(): MapLiteralNode {
        const tok = this.current()
        this.advance() // '{'
        this.advance() // '}'
        return { kind: 'MapLiteral', token: tok, entries: [] }
    }

    // ── Props ──────────────────────────────────────────────────────────────────

    /**
     * Parses a comma-separated list of prop declarations inside a `props` or
     * `state` or `context` block. Stops at `)` or EOF.
     *
     * Forms:
     *   `name(Type)`                  — typed data prop
     *   `name(Type) is default`       — typed prop with default value
     *   `name argName(Type)`          — interaction prop with argument variable
     *   `name`                        — interaction prop with no payload
     *   `?name(Type)`                 — optional typed prop (in context fields)
     */
    private parsePropList(): PropNode[] {
        const props: PropNode[] = []
        while (!this.check(TokenType.RParen) && !this.check(TokenType.EOF)) {
            this.skipTrivia()
            if (this.check(TokenType.RParen)) break

            const tok = this.current()
            let optional = false

            if (this.check(TokenType.Question)) {
                optional = true
                this.advance()
            }

            if (!this.check(TokenType.CamelIdent)) break

            const name = this.advance().value
            this.skipTrivia()

            let type: TypeNode | null = null
            let argName: string | null = null
            let argNameToken: import('../lexer/token').Token | null = null
            let defaultValue: LiteralNode | null = null

            if (this.check(TokenType.LParen)) {
                // name(Type) — direct type annotation
                this.advance()
                type = this.parseType()
                if (!this.expect(TokenType.RParen)) this.syncToClosingParen()
                optional = optional || ('optional' in type && (type as { optional: boolean }).optional)
            } else if (this.check(TokenType.CamelIdent)) {
                // name argName(Type) — interaction prop with argument variable
                argNameToken = this.current()
                argName = this.advance().value
                this.skipTrivia()
                if (this.check(TokenType.LParen)) {
                    this.advance()
                    if (this.check(TokenType.RParen)) {
                        // argName() — parens present but type is missing
                        this.error(
                            DiagnosticCode.P_EMPTY_HANDLER_ARG_TYPE,
                            `Handler argument '${argName}' has no type — declare a type like ${argName}(ContextType)`,
                            this.current()
                        )
                        this.advance() // consume ')'
                    } else {
                        type = this.parseType()
                        if (!this.expect(TokenType.RParen)) this.syncToClosingParen()
                    }
                }
            }

            this.skipTrivia()

            if (this.check(TokenType.Is)) {
                this.advance()
                this.skipTrivia()
                defaultValue = this.parseLiteralValue()
            }

            props.push({ kind: 'Prop', token: tok, name, type, optional, defaultValue, argName, argNameToken })

            this.skipTrivia()
            if (this.check(TokenType.Comma)) this.advance()
        }
        return props
    }

    // ── Types ──────────────────────────────────────────────────────────────────

    /**
     * Parses a type annotation. Called when the cursor is on the type keyword or name.
     */
    private parseType(): TypeNode {
        const tok = this.current()

        if (this.check(TokenType.TList)) {
            this.advance()
            this.expect(TokenType.LParen)
            const elementType = this.parseType()
            this.expect(TokenType.RParen)
            return { kind: 'ListType', token: tok, elementType } as ListTypeNode
        }

        if (this.check(TokenType.TMap)) {
            this.advance()
            this.expect(TokenType.LParen)
            const keyType = this.parseType()
            this.expect(TokenType.Comma)
            this.skipTrivia()
            const valueType = this.parseType()
            this.expect(TokenType.RParen)
            return { kind: 'MapType', token: tok, keyType, valueType } as MapTypeNode
        }

        // Optional flag — applies to both primitives and named types (?string, ?Product)
        let optional = false
        if (this.check(TokenType.Question)) {
            optional = true
            this.advance()
        }

        // Note: the lexer maps the word 'context' to TokenType.Context (the construct
        // keyword token), never to TContext. We accept both here so 'context' works
        // as a type in system interface methods (e.g. returns(context)).
        const primitiveMap: Partial<Record<TokenType, string>> = {
            [TokenType.TString]: 'string',
            [TokenType.TInteger]: 'integer',
            [TokenType.TFloat]: 'float',
            [TokenType.TBoolean]: 'boolean',
            [TokenType.TContext]: 'context',
            [TokenType.Context]: 'context',
        }
        const typeTok = this.current()
        if (typeTok.type in primitiveMap) {
            this.advance()
            return { kind: 'PrimitiveType', token: typeTok, name: primitiveMap[typeTok.type] as PrimitiveType, optional } as PrimitiveTypeNode
        }

        if (this.check(TokenType.PascalIdent)) {
            const name = this.advance().value
            return { kind: 'NamedType', token: typeTok, name, optional } as NamedTypeNode
        }

        this.error(DiagnosticCode.P_MISSING_TYPE, `Expected a type`, typeTok)
        // Consume the unrecognized token so the caller's expect(')') can succeed.
        // Don't advance past ')' or ',' — those are delimiters the caller depends on.
        if (!this.check(TokenType.RParen) && !this.check(TokenType.Comma) && !this.check(TokenType.EOF)) {
            this.advance()
        }
        return { kind: 'NamedType', token: typeTok, name: '?', optional: false } as NamedTypeNode
    }

    // ── Methods ────────────────────────────────────────────────────────────────

    /**
     * Parses a standard method declaration in a provider, adapter, or interface body.
     * Delegates to `parseInterfaceMethod` which also handles handler method bodies.
     */
    private parseMethod(): MethodNode {
        return this.parseInterfaceMethod()
    }

    /**
     * Parses a method declaration that may optionally have a body block of
     * `if` branches — used for handler interface method declarations.
     *
     * Forms:
     *   `methodName "description"`
     *   `methodName param(Type) returns(Type) "description"`
     *   `methodName param(Type) ( if param is "/path" enter State "narrative" )`
     */
    private parseInterfaceMethod(): MethodNode {
        const tok = this.current()
        const name = this.advance().value // camelIdent
        this.skipTrivia()

        const params: PropNode[] = []
        let returnType: TypeNode | null = null
        let description: string | null = null

        // Parse parameters: paramName(Type) or `context is TypeName`
        while (this.check(TokenType.CamelIdent) || this.check(TokenType.Context)) {
            const paramTok = this.current()
            const paramName = this.advance().value
            this.skipTrivia()
            let paramType: TypeNode | null = null
            if (this.check(TokenType.Is)) {
                // `context is TypeName` — keyword-style context binding
                this.advance() // consume 'is'
                this.skipTrivia()
                if (this.check(TokenType.PascalIdent)) {
                    const typeTok = this.current()
                    const typeName = this.advance().value
                    paramType = { kind: 'NamedType', token: typeTok, name: typeName } as NamedTypeNode
                }
            } else if (this.check(TokenType.LParen)) {
                this.advance()
                paramType = this.parseType()
                this.expect(TokenType.RParen)
            }
            params.push({ kind: 'Prop', token: paramTok, name: paramName, type: paramType, optional: false, defaultValue: null, argName: null, argNameToken: null })
            this.skipTrivia()
        }

        // Handler interface method body: ( if ... enter ... )
        // Consume and discard — the body is structural metadata, not executable logic.
        if (this.check(TokenType.LParen)) {
            this.advance()
            let depth = 1
            while (!this.check(TokenType.EOF) && depth > 0) {
                if (this.check(TokenType.LParen)) depth++
                else if (this.check(TokenType.RParen)) depth--
                if (depth > 0) this.advance()
            }
            this.expect(TokenType.RParen)
            return { kind: 'Method', token: tok, name, params, returnType: null, description: null }
        }

        // Optional returns(Type)
        if (this.check(TokenType.Returns)) {
            this.advance()
            this.expect(TokenType.LParen)
            returnType = this.parseType()
            this.expect(TokenType.RParen)
            this.skipTrivia()
        }

        // Optional description string
        if (this.check(TokenType.StringLit)) {
            description = this.advance().value.slice(1, -1)
        }

        return { kind: 'Method', token: tok, name, params, returnType, description }
    }

    // ── Qualified name ─────────────────────────────────────────────────────────

    /**
     * Parses a dot-separated qualified name.
     * e.g. `UIModule.LoginForm`, `system.setContext`, `SessionAdapter.checkSession`
     */
    private parseQualifiedName(): QualifiedName {
        const tok = this.current()
        const parts: string[] = []

        if (
            this.check(TokenType.PascalIdent) ||
            this.check(TokenType.CamelIdent) ||
            this.check(TokenType.System) ||
            this.check(TokenType.State)
        ) {
            parts.push(this.advance().value)
        }

        while (this.check(TokenType.Dot)) {
            this.advance()
            if (
                this.check(TokenType.PascalIdent) ||
                this.check(TokenType.CamelIdent) ||
                this.check(TokenType.State) ||
                this.check(TokenType.System)
            ) {
                parts.push(this.advance().value)
            } else {
                break
            }
        }

        return { kind: 'QualifiedName', token: tok, parts }
    }

    // ── Literal value (for defaults) ───────────────────────────────────────────

    /**
     * Parses a literal value used as a default in a prop or state declaration.
     * Handles strings, integers, floats, booleans, `[]`, and `{}`.
     */
    private parseLiteralValue(): LiteralNode {
        const tok = this.current()
        if (this.check(TokenType.StringLit)) return this.parseStringLiteral()
        if (this.check(TokenType.IntegerLit)) return this.parseIntegerLiteral()
        if (this.check(TokenType.FloatLit)) return this.parseFloatLiteral()
        if (this.check(TokenType.BooleanLit)) return this.parseBooleanLiteral()
        if (this.checkListLiteral()) return this.parseListLiteral()
        if (this.checkMapLiteral()) return this.parseMapLiteral()
        this.error(DiagnosticCode.P_UNEXPECTED_TOKEN, `Expected a literal value`, tok)
        this.advance()
        return { kind: 'StringLiteral', token: tok, value: '' }
    }

    // ── Token stream helpers ───────────────────────────────────────────────────

    private get pos(): number {
        return this.cursor.position
    }

    private set pos(pos: number) {
        this.cursor.position = pos
    }

    /** Returns the token at the current position. */
    private current(): Token {
        return this.cursor.current()
    }

    /** Returns true if the current token has the given type. */
    private check(type: TokenType): boolean {
        return this.cursor.check(type)
    }

    /**
     * Consumes and returns the current token, advancing the position.
     */
    private advance(): Token {
        return this.cursor.advance()
    }

    /**
     * Consumes the current token if it matches `type` and returns it.
     * If it does not match, emits a diagnostic and returns null without advancing.
     */
    private expect(type: TokenType): Token | null {
        return this.cursor.expect(type)
    }

    /**
     * Consumes a PascalIdent or CamelIdent and returns its value.
     * Emits a diagnostic if neither is present.
     */
    private expectIdent(context: string): string {
        return this.cursor.expectIdent(context)
    }

    /**
     * Consumes and returns the string value if the current token is a StringLit.
     * Returns null without advancing if it is not.
     */
    private parseOptionalString(): string | null {
        return this.cursor.parseOptionalString()
    }

    /**
     * Skips tokens until the closing ')' that matches the '(' already consumed.
     * Used for error recovery inside type annotations — consumes the ')' itself.
     */
    private syncToClosingParen(): void {
        this.cursor.syncToClosingParen()
    }

    /**
     * Skips comment tokens only.
     */
    private skipComments(): void {
        this.cursor.skipComments()
    }

    /**
     * Skips comments and newlines — the whitespace between meaningful tokens.
     */
    private skipTrivia(): void {
        this.cursor.skipTrivia()
    }

    /**
     * Returns true if the current token looks like a system.* call.
     */
    private checkSystemCall(): boolean {
        return this.check(TokenType.System)
    }

    /**
     * Returns true if the current token can start an argument (`name is value`).
     * Arguments start with a camelCase identifier.
     */
    private checkArgumentStart(): boolean {
        return this.check(TokenType.CamelIdent)
    }

    /**
     * Returns true if the first non-trivia token after the current position
     * is a CamelIdent. Used to decide whether a comma starts an inline argument
     * list rather than separating two use entries.
     */
    private peekPastTriviaIsCamelIdent(): boolean {
        return this.cursor.peekPastTriviaIsCamelIdent()
    }

    /**
     * Returns true if the current token can start a use entry (component kind,
     * system call, if, or for).
     */
    private isUseEntry(): boolean {
        return (
            this.check(TokenType.View) ||
            this.check(TokenType.Screen) ||
            this.check(TokenType.Adapter) ||
            this.check(TokenType.Provider) ||
            this.check(TokenType.Interface) ||
            this.check(TokenType.If) ||
            this.check(TokenType.For) ||
            this.check(TokenType.System)
        )
    }

    /**
     * Returns true if the current two tokens form a `[` `]` list literal.
     * The lexer does not produce bracket tokens — `[]` is detected by checking
     * for an Unknown token with value `[` followed by one with value `]`.
     */
    private checkListLiteral(): boolean {
        return this.cursor.checkListLiteral()
    }

    /**
     * Returns true if the current two tokens form a `{` `}` map literal.
     */
    private checkMapLiteral(): boolean {
        return this.cursor.checkMapLiteral()
    }

    /**
     * Parses a system.* call expression appearing at the statement level
     * (e.g. inside a module body or a uses block).
     */
    private parseSystemCall(): CallExpressionNode {
        const tok = this.current()
        const callee = this.parseAccessExpression()
        this.skipTrivia()
        const args = this.parseInlineArgList()
        return { kind: 'CallExpression', token: tok, callee, args }
    }

    // ── Error recovery ─────────────────────────────────────────────────────────

    /**
     * Emits a diagnostic at the given token's position.
     */
    private error(code: DiagnosticCode, message: string, tok: Token): void {
        this.cursor.error(code, message, tok)
    }

    /**
     * Advances past tokens until a safe synchronisation point is found.
     * Used after an unrecoverable parse error to resume at the next construct.
     * Synchronisation points: top-level keyword, closing paren, or EOF.
     */
    private synchronise(): void {
        this.cursor.synchronise()
    }
}
