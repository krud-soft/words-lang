import { describe, it, expect } from 'vitest'
import { Lexer } from '../src/lexer/lexer'
import { Parser } from '../src/parser/parser'
import {
    SystemNode,
    ModuleNode,
    StateNode,
    ContextNode,
    ScreenNode,
    ViewNode,
    AdapterNode,
    SimpleReturnsNode,
    ExpandedReturnsNode,
} from '../src/parser/ast'

// ── Helpers ───────────────────────────────────────────────────────────────────

function parse(source: string) {
    const tokens = new Lexer(source).tokenize()
    return new Parser(tokens).parse()
}

// ── System ────────────────────────────────────────────────────────────────────

describe('Parser — system', () => {

    it('parses the TestApp system file', () => {
        const src = `
system TestApp "A minimal test application for the WORDS syntax highlighter" (
    modules (
        AppUIModule
        RoutingModule
        CatalogModule
    )
    interface (
        getContext name(string) returns(context) "Retrieves the value of a stored context by its name"
        setContext name(string) value(context) "Stores a context by name"
        dropContext name(string) "Clears a context identified by name"
    )
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)
        expect(document.nodes).toHaveLength(1)

        const system = document.nodes[0] as SystemNode
        expect(system.kind).toBe('System')
        expect(system.name).toBe('TestApp')
        expect(system.description).toBe('A minimal test application for the WORDS syntax highlighter')
        expect(system.modules).toEqual(['AppUIModule', 'RoutingModule', 'CatalogModule'])
        expect(system.interfaceMethods).toHaveLength(3)
        expect(system.interfaceMethods[0].name).toBe('getContext')
        expect(system.interfaceMethods[1].name).toBe('setContext')
        expect(system.interfaceMethods[2].name).toBe('dropContext')
    })

})

// ── Module ────────────────────────────────────────────────────────────────────

describe('Parser — module', () => {

    it('parses the CatalogModule with a process and start state', () => {
        const src = `
module CatalogModule "Manages order browsing and confirmation" (
    process OrderFlow "Covers the flow from order display through confirmation or cancellation" (
        when OrderDiplaying returns ConfirmOrderCtx
            enter OrderConfirmed "The user confirmed the order"
        when OrderDiplaying returns CancelOrderCtx
            enter OrderCancelled "The user cancelled the order"
    )
    start OrderDiplaying
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)

        const mod = document.nodes[0] as ModuleNode
        expect(mod.kind).toBe('Module')
        expect(mod.name).toBe('CatalogModule')
        expect(mod.processes).toHaveLength(1)
        expect(mod.processes[0].name).toBe('OrderFlow')
        expect(mod.processes[0].rules).toHaveLength(2)
        expect(mod.startState).toBe('OrderDiplaying')
    })

    it('parses when rules correctly', () => {
        const src = `
module CatalogModule (
    process OrderFlow (
        when OrderDiplaying returns ConfirmOrderCtx
            enter OrderConfirmed "The user confirmed the order"
        when OrderDiplaying returns CancelOrderCtx
            enter OrderCancelled "The user cancelled the order"
    )
    start OrderDiplaying
)
    `.trim()

        const { document } = parse(src)
        const mod = document.nodes[0] as ModuleNode
        const rules = mod.processes[0].rules

        expect(rules[0].currentState).toBe('OrderDiplaying')
        expect(rules[0].producedContext).toBe('ConfirmOrderCtx')
        expect(rules[0].nextState).toBe('OrderConfirmed')
        expect(rules[0].narrative).toBe('The user confirmed the order')

        expect(rules[1].currentState).toBe('OrderDiplaying')
        expect(rules[1].producedContext).toBe('CancelOrderCtx')
        expect(rules[1].nextState).toBe('OrderCancelled')
    })

    it('parses an implements block with routing branches', () => {
        const src = `
module CatalogModule (
    implements RoutingModule.RouteSwitchHandler (
        switch path(string) (
            if path is "/orders"
                enter OrderDiplaying "The /orders path activates the order display"
        )
    )
    start OrderDiplaying
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)

        const mod = document.nodes[0] as ModuleNode
        expect(mod.implements).toHaveLength(1)

        const impl = mod.implements[0]
        expect(impl.interfaceName.parts).toEqual(['RoutingModule', 'RouteSwitchHandler'])
        expect(impl.switchParam).toBe('path')
        expect(impl.branches).toHaveLength(1)
        expect(impl.branches[0].targetState).toBe('OrderDiplaying')
        expect(impl.branches[0].narrative).toBe('The /orders path activates the order display')
    })

})

// ── State ─────────────────────────────────────────────────────────────────────

describe('Parser — state', () => {

    it('parses the OrderDiplaying state with ownership declaration', () => {
        const src = `
module CatalogModule
state OrderDiplaying receives OrderContext (
    returns ConfirmOrderCtx, CancelOrderCtx
    uses screen OrderSummaryScreen
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)
        expect(document.ownerModule).toBe('CatalogModule')

        const state = document.nodes[0] as StateNode
        expect(state.kind).toBe('State')
        expect(state.name).toBe('OrderDiplaying')
        expect(state.receives).toBe('OrderContext')
        expect(state.receivesOptional).toBe(false)

        const returns = state.returns as SimpleReturnsNode
        expect(returns.kind).toBe('SimpleReturns')
        expect(returns.contexts).toEqual(['ConfirmOrderCtx', 'CancelOrderCtx'])

        expect(state.uses).toHaveLength(1)
        expect(state.uses[0].kind).toBe('ComponentUse')
    })

    it('parses a state with optional receives', () => {
        const src = `
module CatalogModule
state OrderConfirmed receives ?ConfirmOrderCtx (
    returns OrderAcknowledged
    uses screen OrderConfirmedScreen
)
    `.trim()

        const { document } = parse(src)
        const state = document.nodes[0] as StateNode
        expect(state.receives).toBe('ConfirmOrderCtx')
        expect(state.receivesOptional).toBe(true)
    })

    it('parses a state with expanded returns and side effects', () => {
        const src = `
module SessionModule
state SessionValidating receives StoredSession (
    returns (
        SessionToken (
            system.setContext name is SessionToken, value is state.context
        )
        SessionValidationError (
            system.dropContext name is SessionToken
        )
    )
    uses adapter SessionAdapter.validateSession existing is state.context
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)

        const state = document.nodes[0] as StateNode
        const returns = state.returns as ExpandedReturnsNode
        expect(returns.kind).toBe('ExpandedReturns')
        expect(returns.entries).toHaveLength(2)
        expect(returns.entries[0].contextName).toBe('SessionToken')
        expect(returns.entries[0].sideEffects).toHaveLength(1)
        expect(returns.entries[1].contextName).toBe('SessionValidationError')
        expect(returns.entries[1].sideEffects).toHaveLength(1)
    })

})

// ── Context ───────────────────────────────────────────────────────────────────

describe('Parser — context', () => {

    it('parses the OrderContext', () => {
        const src = `
module CatalogModule
context OrderContext (
    id(string),
    total(float),
    items(list(OrderItem))
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)
        expect(document.ownerModule).toBe('CatalogModule')

        const ctx = document.nodes[0] as ContextNode
        expect(ctx.kind).toBe('Context')
        expect(ctx.name).toBe('OrderContext')
        expect(ctx.fields).toHaveLength(3)
        expect(ctx.fields[0].name).toBe('id')
        expect(ctx.fields[1].name).toBe('total')
        expect(ctx.fields[2].name).toBe('items')
        expect(ctx.fields[2].type?.kind).toBe('ListType')
    })

})

// ── Screen ────────────────────────────────────────────────────────────────────

describe('Parser — screen', () => {

    it('parses the OrderSummaryScreen with nested views and state.return()', () => {
        const src = `
module CatalogModule
screen OrderSummaryScreen "Shows the order summary screen" (
    uses (
        view AppUIModule.NavigationBar (
            currentUser is system.getContext(SystemUser)
        ),
        view OrderSummary (
            orderId is state.context.id,
            items is [],
            total is state.context.total,
            onConfirm is (
                state.return(confirmDetails)
            ),
            onCancel is (
                state.return(cancelDetails)
            )
        )
    )
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)
        expect(document.ownerModule).toBe('CatalogModule')

        const screen = document.nodes[0] as ScreenNode
        expect(screen.kind).toBe('Screen')
        expect(screen.name).toBe('OrderSummaryScreen')
        expect(screen.description).toBe('Shows the order summary screen')
        expect(screen.uses).toHaveLength(2)

        // First view: AppUIModule.NavigationBar
        const navBar = screen.uses[0] as any
        expect(navBar.componentKind).toBe('view')
        expect(navBar.name.parts).toEqual(['AppUIModule', 'NavigationBar'])
        expect(navBar.args).toHaveLength(1)
        expect(navBar.args[0].name).toBe('currentUser')

        // Second view: OrderSummary
        const orderSummary = screen.uses[1] as any
        expect(orderSummary.name.parts).toEqual(['OrderSummary'])
        expect(orderSummary.args).toHaveLength(5)

        // onConfirm is ( state.return(confirmDetails) )
        const onConfirmArg = orderSummary.args[3]
        expect(onConfirmArg.name).toBe('onConfirm')
        expect(onConfirmArg.value.kind).toBe('BlockExpression')
        expect(onConfirmArg.value.statements[0].kind).toBe('StateReturnStatement')
        expect(onConfirmArg.value.statements[0].contextName).toBe('confirmDetails')
    })

    it('parses conditional rendering in a screen', () => {
        const src = `
module AuthModule
screen LoginScreen (
    uses (
        if state.context is AccountDeauthenticated (
            view UIModule.Notification type is "warning", message is state.context.reason
        )
        view UIModule.LoginForm (
            onSubmit is (
                state.return(credentials)
            )
        )
    )
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)

        const screen = document.nodes[0] as ScreenNode
        expect(screen.uses).toHaveLength(2)
        expect(screen.uses[0].kind).toBe('ConditionalBlock')
        expect(screen.uses[1].kind).toBe('ComponentUse')
    })

    it('parses a for...as iteration block in a screen', () => {
        const src = `
module NotificationsModule
screen NotificationsScreen (
    uses (
        for state.context.notifications as notification (
            view UIModule.NotificationCard (
                message is notification.message,
                type is notification.type
            )
        )
    )
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)

        const screen = document.nodes[0] as ScreenNode
        expect(screen.uses).toHaveLength(1)
        expect(screen.uses[0].kind).toBe('IterationBlock')

        const iter = screen.uses[0] as any
        expect(iter.collection.path).toEqual(['state', 'context', 'notifications'])
        expect(iter.bindings).toEqual(['notification'])
        expect(iter.body).toHaveLength(1)
    })

})

// ── View ──────────────────────────────────────────────────────────────────────

describe('Parser — view', () => {

    it('parses the OrderSummary view with props and interaction props', () => {
        const src = `
module CatalogModule
view OrderSummary "Renders a summary of the current order with confirm and cancel controls" (
    props (
        orderId(string),
        items(list(OrderItem)),
        total(float),
        onConfirm confirmDetails(ConfirmOrderCtx),
        onCancel cancelDetails(CancelOrderCtx)
    )
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)

        const view = document.nodes[0] as ViewNode
        expect(view.kind).toBe('View')
        expect(view.name).toBe('OrderSummary')
        expect(view.props).toHaveLength(5)

        // Data prop
        expect(view.props[0].name).toBe('orderId')
        expect(view.props[0].type?.kind).toBe('PrimitiveType')
        expect(view.props[0].argName).toBeNull()

        // Interaction prop with argument variable
        expect(view.props[3].name).toBe('onConfirm')
        expect(view.props[3].argName).toBe('confirmDetails')
        expect(view.props[3].type?.kind).toBe('NamedType')

        expect(view.props[4].name).toBe('onCancel')
        expect(view.props[4].argName).toBe('cancelDetails')
    })

    it('parses a view with local state and default values', () => {
        const src = `
module AuthModule
view LoginFormSection (
    props (
        onSubmit credentials(AccountCredentials)
    )
    state (
        inputEmail(string) is "",
        inputPassword(string) is "",
        isSubmitting(boolean) is false
    )
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)

        const view = document.nodes[0] as ViewNode
        expect(view.state).toHaveLength(3)
        expect(view.state[0].name).toBe('inputEmail')
        expect(view.state[0].defaultValue?.kind).toBe('StringLiteral')
        expect(view.state[2].name).toBe('isSubmitting')
        expect(view.state[2].defaultValue?.kind).toBe('BooleanLiteral')
    })

})

// ── Adapter ───────────────────────────────────────────────────────────────────

describe('Parser — adapter', () => {

    it('parses an adapter with props and interface methods', () => {
        const src = `
module AuthModule
adapter AuthAdapter "Connects to the authentication service" (
    props (
        baseUrl(string),
        timeoutMs(integer) is 5000
    )
    interface (
        login credentials(AccountCredentials) returns(SystemUser)
            "Authenticates the user against the backend"
        logout session(SessionToken)
            "Invalidates the current session"
    )
)
    `.trim()

        const { document, diagnostics } = parse(src)
        expect(diagnostics).toHaveLength(0)

        const adapter = document.nodes[0] as AdapterNode
        expect(adapter.kind).toBe('Adapter')
        expect(adapter.name).toBe('AuthAdapter')
        expect(adapter.props).toHaveLength(2)
        expect(adapter.props[1].defaultValue?.kind).toBe('IntegerLiteral')
        expect(adapter.methods).toHaveLength(2)
        expect(adapter.methods[0].name).toBe('login')
        expect(adapter.methods[0].returnType?.kind).toBe('NamedType')
        expect(adapter.methods[1].name).toBe('logout')
        expect(adapter.methods[1].returnType).toBeNull()
    })

})

// ── Error recovery ────────────────────────────────────────────────────────────

describe('Parser — error recovery', () => {

    it('collects multiple errors and still returns a partial AST', () => {
        const src = `
module CatalogModule
state BadState receives (
    returns
    uses screen
)
    `.trim()

        const { document, diagnostics } = parse(src)
        // Errors are collected, not thrown
        expect(diagnostics.length).toBeGreaterThan(0)
        // Partial AST is still returned
        expect(document).toBeDefined()
        expect(document.ownerModule).toBe('CatalogModule')
    })

    it('reports correct line and column for a missing identifier', () => {
        const src = `module CatalogModule\nstate receives OrderContext (\n    returns ConfirmOrderCtx\n)`
        const { diagnostics } = parse(src)
        const missing = diagnostics.find(d => d.code === 'P009')
        expect(missing).toBeDefined()
        // Should point at 'receives' on line 2 (0-based: line 1)
        expect(missing!.range.start.line).toBe(1)
    })

})