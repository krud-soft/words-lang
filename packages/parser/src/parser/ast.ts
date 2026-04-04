import { Token } from '../lexer/token'

// ── Base ──────────────────────────────────────────────────────────────────────

/**
 * Every AST node extends BaseNode.
 * The `kind` discriminant lets TypeScript narrow union types safely.
 * The `token` is the first token that produced this node — used by the
 * analyser to report diagnostics at the correct source location, and by
 * the LSP to implement go-to-definition and find-references.
 */
export interface BaseNode {
    kind: string
    token: Token
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The built-in scalar types available in WORDS.
 * `context` is a special type used only in the system interface declaration
 * (getContext / setContext) to represent an opaque stored context value.
 */
export type PrimitiveType = 'string' | 'integer' | 'float' | 'boolean' | 'context'

/**
 * A scalar built-in type — string, integer, float, boolean, or context.
 * e.g. `name(string)`, `total(float)`
 */
export interface PrimitiveTypeNode extends BaseNode {
    kind: 'PrimitiveType'
    name: PrimitiveType
    optional: boolean
}

/**
 * A parameterised list type.
 * e.g. `list(OrderItem)`, `list(string)`
 */
export interface ListTypeNode extends BaseNode {
    kind: 'ListType'
    elementType: TypeNode
}

/**
 * A parameterised map type with explicit key and value types.
 * e.g. `map(string, OrderSummary)`
 */
export interface MapTypeNode extends BaseNode {
    kind: 'MapType'
    keyType: TypeNode
    valueType: TypeNode
}

/**
 * A reference to a named interface component used as a type.
 * e.g. `Product`, `?AuthError`, `OrderItem`
 * The `optional` flag is set when the type is prefixed with `?`.
 */
export interface NamedTypeNode extends BaseNode {
    kind: 'NamedType'
    name: string
    optional: boolean
}

/**
 * Union of all type annotation forms that can appear after a name
 * in a prop, method parameter, or returns clause.
 */
export type TypeNode =
    | PrimitiveTypeNode
    | ListTypeNode
    | MapTypeNode
    | NamedTypeNode

// ── Qualified name ────────────────────────────────────────────────────────────

/**
 * A dot-separated name that references a construct across module boundaries,
 * or a runtime system call. Parts are stored as an array so the analyser can
 * resolve each segment independently.
 *
 * Examples:
 *   UIModule.LoginForm            → ['UIModule', 'LoginForm']
 *   system.setContext             → ['system', 'setContext']
 *   system.RoutingModule.dispatch → ['system', 'RoutingModule', 'dispatch']
 *   SessionAdapter.checkSession   → ['SessionAdapter', 'checkSession']
 */
export interface QualifiedName extends BaseNode {
    kind: 'QualifiedName'
    parts: string[]
}

// ── Prop / field declaration ──────────────────────────────────────────────────

/**
 * A single named, typed entry in a `props` or `state` block.
 *
 * Props declared with a type are data props:
 *   `error(AuthError)`
 *     → name='error', type=NamedTypeNode('AuthError'), argName=null
 *
 * Props declared with an argument name and type are interaction props.
 * The argument name is the variable the parent passes into the handler body:
 *   `onSubmit credentials(AccountCredentials)`
 *     → name='onSubmit', type=NamedTypeNode('AccountCredentials'), argName='credentials'
 *
 * Props declared with no type are interaction props with no payload.
 * The handler body receives no variable:
 *   `onConfirm`
 *     → name='onConfirm', type=null, argName=null
 *
 * Interaction prop names are chosen by the designer — there are no reserved
 * names. `onSubmit`, `onConfirm`, `onDismiss`, `onLoad` are all plain prop
 * names with no special meaning to the language.
 *
 * In a `state` block:
 *   `inputEmail(string) is ""`
 *     → name='inputEmail', type=PrimitiveTypeNode('string'), defaultValue=StringLiteralNode('')
 *
 * `optional` is true when the type is prefixed with `?` — e.g. `?Product`.
 * `argName` is the argument variable name declared on an interaction prop,
 * inferred by the parser and used downstream at call sites.
 */
export interface PropNode extends BaseNode {
    kind: 'Prop'
    name: string
    type: TypeNode | null
    optional: boolean
    defaultValue: LiteralNode | null
    argName: string | null
}

// ── Literals ──────────────────────────────────────────────────────────────────

/** A double-quoted string value. e.g. `"The user authenticated successfully"` */
export interface StringLiteralNode extends BaseNode {
    kind: 'StringLiteral'
    value: string
}

/** A whole number value. e.g. `42`, `5000` */
export interface IntegerLiteralNode extends BaseNode {
    kind: 'IntegerLiteral'
    value: number
}

/** A decimal number value. e.g. `0.0`, `3.14` */
export interface FloatLiteralNode extends BaseNode {
    kind: 'FloatLiteral'
    value: number
}

/** A boolean value — `true` or `false`. */
export interface BooleanLiteralNode extends BaseNode {
    kind: 'BooleanLiteral'
    value: boolean
}

/**
 * An empty list literal `[]`.
 * Non-empty list literals do not appear in WORDS source — `[]` is the only
 * form used as a default value in props and state declarations.
 */
export interface ListLiteralNode extends BaseNode {
    kind: 'ListLiteral'
    elements: LiteralNode[]
}

/**
 * An empty map literal `{}`.
 * Non-empty map literals do not appear in WORDS source — `{}` is the only
 * form used as a default value in props and state declarations.
 */
export interface MapLiteralNode extends BaseNode {
    kind: 'MapLiteral'
    entries: Array<{ key: LiteralNode; value: LiteralNode }>
}

/**
 * Union of all literal value forms.
 * Literals appear as default values in props/state declarations and as
 * argument values in component use and system calls.
 */
export type LiteralNode =
    | StringLiteralNode
    | IntegerLiteralNode
    | FloatLiteralNode
    | BooleanLiteralNode
    | ListLiteralNode
    | MapLiteralNode

// ── Interface method declaration ──────────────────────────────────────────────

/**
 * A method exposed by a provider, adapter, or interface component.
 * Methods appear directly in the body after `props`, without a keyword prefix.
 * Method names are chosen by the designer — there are no reserved names.
 *
 * Examples:
 *   `getProducts returns(list(Product)) "Returns all products"`
 *   `login credentials(AccountCredentials) returns(SystemUser) "Authenticates the user"`
 *   `clear "Empties the cart"` — no params, no return type
 *
 * `returnType` is null when the method produces no output.
 * `description` is the optional quoted string following the method signature.
 */
export interface MethodNode extends BaseNode {
    kind: 'Method'
    name: string
    params: PropNode[]
    returnType: TypeNode | null
    description: string | null
}

// ── Returns clause ────────────────────────────────────────────────────────────

/**
 * The simple form of a returns clause — a comma-separated list of context names.
 * e.g. `returns AccountCredentials, AuthError`
 * Each name must have a corresponding `when` rule in the module's process.
 */
export interface SimpleReturnsNode extends BaseNode {
    kind: 'SimpleReturns'
    contexts: string[]
}

/**
 * A side effect declared inside an expanded returns entry.
 * Side effects execute before the context is produced and the module transitions.
 *
 * Examples:
 *   `system.setContext name is SessionToken, value is state.context`
 *   `system.dropContext name is SessionToken`
 */
export interface SideEffectNode extends BaseNode {
    kind: 'SideEffect'
    call: QualifiedName
    args: ArgumentNode[]
}

/**
 * A single entry inside an expanded returns block — one context name with
 * zero or more side effects that execute before the context is produced.
 */
export interface ExpandedReturnNode extends BaseNode {
    kind: 'ExpandedReturn'
    contextName: string
    sideEffects: SideEffectNode[]
}

/**
 * The expanded form of a returns clause, used when one or more returned
 * contexts need to carry side effects.
 *
 * Example:
 *   returns (
 *     SessionToken (
 *       system.setContext name is SessionToken, value is state.context
 *     )
 *     SessionValidationError (
 *       system.dropContext name is SessionToken
 *     )
 *   )
 */
export interface ExpandedReturnsNode extends BaseNode {
    kind: 'ExpandedReturns'
    entries: ExpandedReturnNode[]
}

/**
 * Union of the two forms a returns clause can take inside a state definition.
 * The analyser resolves context names from both forms identically.
 */
export type ReturnsNode = SimpleReturnsNode | ExpandedReturnsNode

// ── Argument (is-assignment) ──────────────────────────────────────────────────

/**
 * A named argument passed to a component, system call, or method.
 * Always written as `name is value`.
 *
 * The argument name on the left of `is` is either a prop name being wired up
 * (e.g. `type`, `message`, `orderId`) or an interaction prop name defined by
 * the designer on the target component (e.g. `onSubmit`, `onConfirm`, `onDismiss`).
 *
 * Examples:
 *   `type is "warning"`
 *   `message is state.context.reason`
 *   `name is SessionToken, value is state.context`
 */
export interface ArgumentNode extends BaseNode {
    kind: 'Argument'
    name: string
    value: ExpressionNode
}

// ── Expressions ───────────────────────────────────────────────────────────────

/**
 * A dot-separated property access path.
 * Used wherever a value is read from state, props, or a bound iteration variable.
 *
 * Examples:
 *   `state.context.fullName` → path = ['state', 'context', 'fullName']
 *   `props.items`            → path = ['props', 'items']
 *   `notification.message`   → path = ['notification', 'message']
 */
export interface AccessExpressionNode extends BaseNode {
    kind: 'AccessExpression'
    path: string[]
}

/**
 * A function or method call expression.
 * Used for system calls and adapter method invocations with arguments.
 *
 * Examples:
 *   `system.getContext(SystemUser)`
 *   `props.onConfirm(orderId is props.orderId, action is "Confirmed")`
 *
 * Note: `onConfirm` in the second example is not a language keyword — it is
 * an interaction prop name defined by the designer on the target component.
 */
export interface CallExpressionNode extends BaseNode {
    kind: 'CallExpression'
    callee: AccessExpressionNode | QualifiedName
    args: ArgumentNode[]
}

/**
 * A `state.return(contextName)` expression — the mechanism through which
 * a screen drives a state transition by producing a named context.
 * The contextName must match one of the state's declared `returns` entries.
 */
export interface StateReturnExpressionNode extends BaseNode {
    kind: 'StateReturnExpression'
    contextName: string
}

/**
 * An inline block expression written as `( ... )`.
 * Used as the value of an interaction prop argument to group one or more
 * statements. The interaction prop name is defined by the designer — the
 * language places no restriction on what it is called.
 *
 * Example:
 *   onSubmit is (
 *     state.return(credentials)
 *   )
 *
 * Here `onSubmit` is a prop name declared by the view designer, not a keyword.
 */
export interface BlockExpressionNode extends BaseNode {
    kind: 'BlockExpression'
    statements: StatementNode[]
}

/**
 * Union of all expression forms that can appear as the value of an argument,
 * a condition operand, or a prop default.
 */
export type ExpressionNode =
    | AccessExpressionNode
    | CallExpressionNode
    | StateReturnExpressionNode
    | BlockExpressionNode
    | LiteralNode

// ── Statements (inside block expressions) ────────────────────────────────────

/**
 * An assignment statement inside a block expression.
 * Used inside interaction prop handler bodies to write values into
 * the component's local state when the interaction fires.
 *
 * The prop name that wraps this block is defined by the designer
 * (e.g. a prop named `onLoad` on a view, or `onSuccess` on an adapter use).
 * The statement itself assigns the received value into a state field.
 *
 * Example: `state.reviews is reviews`
 *   — inside a block that is the value of a designer-named interaction prop.
 */
export interface AssignmentStatementNode extends BaseNode {
    kind: 'AssignmentStatement'
    target: AccessExpressionNode
    value: ExpressionNode
}

/**
 * A `state.return(contextName)` statement inside a block expression.
 * This is the statement form of StateReturnExpressionNode — it appears
 * as the body of an interaction prop handler, driving the state transition
 * when the user performs the corresponding action.
 *
 * The interaction prop that wraps this statement is named by the designer.
 * e.g. `onConfirm is ( state.return(confirmDetails) )`
 */
export interface StateReturnStatementNode extends BaseNode {
    kind: 'StateReturnStatement'
    contextName: string
}

/**
 * Union of all statement forms that can appear inside a block expression body.
 */
export type StatementNode =
    | AssignmentStatementNode
    | StateReturnStatementNode

// ── Conditional block ─────────────────────────────────────────────────────────

/**
 * A boolean condition evaluated inside a `uses` block.
 * The `left` side is always a property access — `state.context`,
 * `state.context.status`, or `props.someField`.
 * The `right` side is the value being compared against.
 * `operator` is either `'is'` (equality) or `'is not'` (inequality).
 *
 * Examples:
 *   `state.context is AccountDeauthenticated`
 *   `state.context.status is "pending"`
 *   `state.context is not AccountRecovered`
 */
export interface ConditionNode extends BaseNode {
    kind: 'Condition'
    left: AccessExpressionNode
    operator: 'is' | 'is not'
    right: ExpressionNode
}

/**
 * A conditional component mount — `if <condition> ( ... )`.
 * The body contains the same entries as a `uses` block and is only
 * activated when the condition evaluates to true at runtime.
 */
export interface ConditionalBlockNode extends BaseNode {
    kind: 'ConditionalBlock'
    condition: ConditionNode
    body: UseEntryNode[]
}

// ── Iteration block ───────────────────────────────────────────────────────────

/**
 * A `for <collection> as <binding> ( ... )` iteration block.
 * Produces one instance of each child component per item in the collection.
 *
 * For a list: `bindings` has one entry — the item variable name.
 * For a map:  `bindings` has two entries — the key variable and the value variable.
 *
 * Examples:
 *   `for state.context.notifications as notification ( ... )`
 *     → collection = AccessExpression(['state','context','notifications']),
 *       bindings = ['notification']
 *   `for state.context.productsByCategoryMap as category, products ( ... )`
 *     → bindings = ['category', 'products']
 */
export interface IterationBlockNode extends BaseNode {
    kind: 'IterationBlock'
    collection: AccessExpressionNode
    bindings: string[]
    body: UseEntryNode[]
}

// ── Component use entries ─────────────────────────────────────────────────────

/**
 * A single component activation inside a `uses` block.
 * Covers all five component kinds — screen, view, adapter, provider, interface.
 *
 * `name` is a QualifiedName because components can be referenced across modules:
 *   `view UIModule.LoginForm ( ... )`
 *   `adapter SessionAdapter.checkSession`
 *   `screen LoginScreen`
 *
 * `args` are the named arguments passed to the component via `is` assignments.
 * Argument names on the left of `is` correspond to prop names declared by the
 * designer on the target component — the language imposes no naming convention.
 *
 * `uses` holds any nested component uses declared inline (view composition).
 */
export interface ComponentUseNode extends BaseNode {
    kind: 'ComponentUse'
    componentKind: 'screen' | 'view' | 'adapter' | 'provider' | 'interface'
    name: QualifiedName
    args: ArgumentNode[]
    uses: UseEntryNode[]
}

/**
 * Union of everything that can appear as an entry inside a `uses` block:
 * - A direct component activation (screen, view, adapter, provider, interface)
 * - A conditional block (`if ...`)
 * - An iteration block (`for ... as ...`)
 */
export type UseEntryNode =
    | ComponentUseNode
    | ConditionalBlockNode
    | IterationBlockNode

// ── Process transition ────────────────────────────────────────────────────────

/**
 * An inline context construction block following a transition narrative.
 * Used when a state is entered from an external trigger (e.g. an implements
 * handler) and the incoming data must be shaped into the context the
 * receiving state expects.
 *
 * Example:
 *   enter Unauthenticated "The user's session has expired" (
 *     reason is "The session has expired"
 *     code is "ERR:01"
 *   )
 */
export interface InlineContextNode extends BaseNode {
    kind: 'InlineContext'
    args: ArgumentNode[]
}

/**
 * A single `when` rule inside a process body.
 * Declares that when the module is in `currentState` and produces `producedContext`,
 * it should enter `nextState`.
 *
 * `narrative` is the optional quoted explanation of why the transition occurs.
 * `inlineContext` is present only when the transition is triggered externally
 * and the context must be constructed inline.
 */
export interface WhenRuleNode extends BaseNode {
    kind: 'WhenRule'
    currentState: string
    producedContext: string
    nextState: string
    narrative: string | null
    inlineContext: InlineContextNode | null
}

/**
 * A process definition inside a module.
 * Contains the complete transition map for one scenario — every state the
 * module can be in under that scenario, what each state produces, and
 * where the module goes next.
 */
export interface ProcessNode extends BaseNode {
    kind: 'Process'
    name: string
    description: string | null
    rules: WhenRuleNode[]
}

// ── Implements block ──────────────────────────────────────────────────────────

/**
 * The body of a single `if` branch inside an `implements` switch handler.
 * Maps a path condition to a state transition.
 *
 * Example:
 *   if path is "/products"
 *     enter ProductList "The /products path activates the product list"
 */
export interface ImplementsBranchNode extends BaseNode {
    kind: 'ImplementsBranch'
    condition: ConditionNode
    targetState: string
    narrative: string | null
}

/**
 * An `implements ModuleName.HandlerInterface ( ... )` block inside a module.
 * Declares that this module implements the named handler interface and
 * provides the switch logic for routing incoming events to local states.
 *
 * Example:
 *   implements RoutingModule.RouteSwitchHandler (
 *     switch path(string) (
 *       if path is "/products"
 *         enter ProductList "The /products path activates the product list"
 *     )
 *   )
 */
export interface ImplementsHandlerNode extends BaseNode {
    kind: 'ImplementsHandler'
    interfaceName: QualifiedName
    switchParam: string
    switchParamType: TypeNode
    branches: ImplementsBranchNode[]
}

// ── Top-level constructs ──────────────────────────────────────────────────────

/**
 * The root construct of a WORDS project — appears exactly once, in the
 * system file at the project root.
 * Names the application, lists every module it contains, and declares
 * the three built-in system interface methods (getContext, setContext, dropContext).
 */
export interface SystemNode extends BaseNode {
    kind: 'System'
    name: string
    description: string | null
    modules: string[]
    interfaceMethods: MethodNode[]
}

/**
 * A module definition — the primary organisational unit below the system level.
 * Contains the module's process definitions, starting state, cross-module
 * implements blocks, and any top-level system subscription calls.
 *
 * `startState` is the state the module enters autonomously on initialisation.
 * It is null for stateless modules or modules triggered externally.
 *
 * `subscriptions` are top-level `system.ModuleName.subscribeRoute ...` calls
 * declared directly in the module body.
 *
 * `inlineInterfaces` are interface declarations written inline inside the
 * module body (e.g. handler interface shapes in RoutingModule).
 */
export interface ModuleNode extends BaseNode {
    kind: 'Module'
    name: string
    description: string | null
    processes: ProcessNode[]
    startState: string | null
    implements: ImplementsHandlerNode[]
    subscriptions: CallExpressionNode[]
    inlineInterfaces: InterfaceNode[]
}

/**
 * A state definition — the smallest behavioral unit in a WORDS specification.
 * Represents a stable condition the module is in, what it expects on entry,
 * what it can produce to drive the next transition, and what it uses while resident.
 *
 * `module` is the owning module name from the ownership declaration line.
 * `receives` is the name of the context expected on entry, or null if the state
 * takes no context. `receivesOptional` is true when prefixed with `?`.
 * `returns` is null for transient states that produce no output.
 * `uses` is empty for states with no components.
 */
export interface StateNode extends BaseNode {
    kind: 'State'
    module: string
    name: string
    receives: string | null
    receivesOptional: boolean
    returns: ReturnsNode | null
    uses: UseEntryNode[]
}

/**
 * A context definition — the structured, typed data that flows between states.
 * Every context is named, belongs to a module, and declares its fields as props.
 * Referenced by name in state `receives` and `returns` clauses and in process
 * `when` rules.
 */
export interface ContextNode extends BaseNode {
    kind: 'Context'
    module: string
    name: string
    fields: PropNode[]
}

/**
 * A screen definition — the top-level UI unit used by a state.
 * Has implicit access to `state.context` and `state.return()`.
 * Can only be used by a state, never by another component.
 * Its `uses` block activates view components and may contain
 * conditional blocks and iteration blocks.
 */
export interface ScreenNode extends BaseNode {
    kind: 'Screen'
    module: string
    name: string
    description: string | null
    uses: UseEntryNode[]
}

/**
 * A view definition — a reusable rendering unit.
 * Receives all data and interaction props via `props`.
 * Interaction prop names are defined by the designer — the language
 * imposes no naming convention on them.
 * Has no access to `state.context` or `state.return()`.
 * Can declare local mutable `state` for concerns it owns entirely
 * (input values, toggle states, hover conditions).
 * Can use other views in its own `uses` block.
 */
export interface ViewNode extends BaseNode {
    kind: 'View'
    module: string
    name: string
    description: string | null
    props: PropNode[]
    state: PropNode[]
    uses: UseEntryNode[]
}

/**
 * A provider definition — computes and exposes in-memory derived data.
 * Never performs I/O — delegates all external data fetching to adapters
 * received through `props`. Exposes its data through named methods.
 * Maintains its own internal `state` between method calls.
 */
export interface ProviderNode extends BaseNode {
    kind: 'Provider'
    module: string
    name: string
    description: string | null
    props: PropNode[]
    state: PropNode[]
    methods: MethodNode[]
}

/**
 * An adapter definition — the I/O boundary of the system.
 * The only construct permitted to communicate with the outside world
 * (HTTP APIs, databases, local storage, hardware).
 * The only construct permitted to be async.
 * Receives environment-level configuration through `props`.
 * Maintains runtime state (connection state, cached tokens, retry counters)
 * in its own `state` block.
 * Exposes all external communication through named methods.
 * Method names are defined by the designer.
 */
export interface AdapterNode extends BaseNode {
    kind: 'Adapter'
    module: string
    name: string
    description: string | null
    props: PropNode[]
    state: PropNode[]
    methods: MethodNode[]
}

/**
 * An interface component definition — a named, typed contract for anything
 * that does not fit the role of screen, view, provider, or adapter.
 * Used as a data model (Product, CartItem), a helper (CatalogueFilter),
 * a handler shape (RouteSwitchHandler), or a callable contract (Pagination).
 *
 * Interface components are the typed vocabulary that all other components
 * reference in their own props and method declarations.
 *
 * When an interface component has a `uses` block, it activates adapters
 * or providers to populate its internal `state`. The interaction props
 * that wire adapter results into state are declared by the designer on
 * the interface component itself — they are plain prop names, not keywords.
 */
export interface InterfaceNode extends BaseNode {
    kind: 'Interface'
    module: string
    name: string
    description: string | null
    props: PropNode[]
    state: PropNode[]
    methods: MethodNode[]
    uses: UseEntryNode[]
}

// ── Top-level union ───────────────────────────────────────────────────────────

/**
 * Union of all constructs that can appear as top-level nodes in a document.
 * A document typically contains exactly one top-level node (e.g. one state,
 * one screen, one context) plus an optional ownership declaration line.
 * The system file and module files may contain more complex structures.
 */
export type TopLevelNode =
    | SystemNode
    | ModuleNode
    | StateNode
    | ContextNode
    | ScreenNode
    | ViewNode
    | ProviderNode
    | AdapterNode
    | InterfaceNode

// ── Document root ─────────────────────────────────────────────────────────────

/**
 * The root node produced by parsing a single `.wds` file.
 *
 * `ownerModule` captures the bare `module ModuleName` ownership declaration
 * that appears on its own line at the top of component files (states, screens,
 * views, etc.). It is null in the system file and in module files where the
 * module declaration opens a body block rather than standing alone.
 *
 * `nodes` contains all top-level constructs found in the file. Most component
 * files will have exactly one node. Module files may have one (the module itself).
 * The system file will have one SystemNode.
 */
export interface DocumentNode {
    kind: 'Document'
    ownerModule: string | null
    nodes: TopLevelNode[]
}