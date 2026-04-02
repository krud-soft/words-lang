import { describe, it, expect, beforeAll } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { Workspace } from '../src/analyser/workspace'
import { Analyser } from '../src/analyser/analyser'
import { DiagnosticCode } from '../src/analyser/diagnostics'

// ── Test project builder ───────────────────────────────────────────────────────

/**
 * Writes a set of named source files to a temporary directory and returns
 * the directory path. Used to build minimal test projects inline.
 */
function buildTestProject(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'words-test-'))
    for (const [relativePath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, relativePath)
        fs.mkdirSync(path.dirname(fullPath), { recursive: true })
        fs.writeFileSync(fullPath, content, 'utf-8')
    }
    return dir
}

// ── TestApp project ───────────────────────────────────────────────────────────

/**
 * A complete valid WORDS project based on the TestApp specification.
 * All analyser rules should pass against this project with no diagnostics.
 */
const VALID_TEST_APP: Record<string, string> = {
    'TestApp.wds': `
system TestApp "A minimal test application" (
    modules (
        AppUIModule
        RoutingModule
        CatalogModule
    )
    interface (
        getContext name(string) returns(context) "Retrieves a stored context"
        setContext name(string) value(context) "Stores a context"
        dropContext name(string) "Clears a context"
    )
)
  `.trim(),

    'AppUIModule/AppUIModule.wds': `
module AppUIModule "Provides shared UI components" (
)
  `.trim(),

    'AppUIModule/views/NavigationBar.wds': `
module AppUIModule
view NavigationBar "Renders the top navigation bar" (
    props (
        currentUser(SystemUser)
    )
)
  `.trim(),

    'AppUIModule/interfaces/SystemUser.wds': `
module AppUIModule
interface SystemUser "Represents the currently authenticated user" (
    props (
        id(string),
        fullName(string),
        email(string)
    )
)
  `.trim(),

    'RoutingModule/RoutingModule.wds': `
module RoutingModule "Handles path-based routing" (
    interface RouteSwitchHandler (
        switch path(string) (
            if path is "/orders"
                enter OrderDiplaying "The /orders path activates the order display"
        )
    )
)
  `.trim(),

    'CatalogModule/CatalogModule.wds': `
module CatalogModule "Manages order browsing and confirmation" (
    process OrderFlow "Covers the order display flow" (
        when OrderDiplaying returns ConfirmOrderCtx
            enter OrderConfirmed "The user confirmed the order"
        when OrderDiplaying returns CancelOrderCtx
            enter OrderCancelled "The user cancelled the order"
        when OrderConfirmed returns OrderAcknowledged
            enter OrderDiplaying "Back to order display"
        when OrderCancelled returns OrderAcknowledged
            enter OrderDiplaying "Back to order display"
    )
    implements RoutingModule.RouteSwitchHandler (
        switch path(string) (
            if path is "/orders"
                enter OrderDiplaying "The /orders path activates the order display"
        )
    )
    system.RoutingModule.subscribeRoute path is "/orders", handler is CatalogModule
    start OrderDiplaying
)
  `.trim(),

    'CatalogModule/contexts/OrderContext.wds': `
module CatalogModule
context OrderContext (
    id(string),
    total(float),
    items(list(OrderItem))
)
  `.trim(),

    'CatalogModule/contexts/ConfirmOrderCtx.wds': `
module CatalogModule
context ConfirmOrderCtx (
    orderId(string),
    confirmedAt(string)
)
  `.trim(),

    'CatalogModule/contexts/CancelOrderCtx.wds': `
module CatalogModule
context CancelOrderCtx (
    orderId(string),
    cancelledAt(string)
)
  `.trim(),

    'CatalogModule/contexts/OrderAcknowledged.wds': `
module CatalogModule
context OrderAcknowledged (
    orderId(string)
)
  `.trim(),

    'CatalogModule/states/OrderDiplaying.wds': `
module CatalogModule
state OrderDiplaying receives OrderContext (
    returns ConfirmOrderCtx, CancelOrderCtx
    uses screen OrderSummaryScreen
)
  `.trim(),

    'CatalogModule/states/OrderConfirmed.wds': `
module CatalogModule
state OrderConfirmed receives ConfirmOrderCtx (
    returns OrderAcknowledged
    uses screen OrderConfirmedScreen
)
  `.trim(),

    'CatalogModule/states/OrderCancelled.wds': `
module CatalogModule
state OrderCancelled receives CancelOrderCtx (
    returns OrderAcknowledged
    uses screen OrderCancelledScreen
)
  `.trim(),

    'CatalogModule/screens/OrderSummaryScreen.wds': `
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
                state.return(ConfirmOrderCtx)
            ),
            onCancel is (
                state.return(CancelOrderCtx)
            )
        )
    )
)
  `.trim(),

    'CatalogModule/screens/OrderConfirmedScreen.wds': `
module CatalogModule
screen OrderConfirmedScreen "Shown after order confirmation" (
    uses (
        view AppUIModule.NavigationBar (
            currentUser is system.getContext(SystemUser)
        )
    )
)
  `.trim(),

    'CatalogModule/screens/OrderCancelledScreen.wds': `
module CatalogModule
screen OrderCancelledScreen "Shown after order cancellation" (
    uses (
        view AppUIModule.NavigationBar (
            currentUser is system.getContext(SystemUser)
        )
    )
)
  `.trim(),

    'CatalogModule/views/OrderSummary.wds': `
module CatalogModule
view OrderSummary "Renders a summary of the current order" (
    props (
        orderId(string),
        items(list(OrderItem)),
        total(float),
        onConfirm confirmDetails(ConfirmOrderCtx),
        onCancel cancelDetails(CancelOrderCtx)
    )
)
  `.trim(),

    'CatalogModule/interfaces/OrderItem.wds': `
module CatalogModule
interface OrderItem "Represents a single line item in an order" (
    props (
        productId(string),
        name(string),
        quantity(integer),
        unitPrice(float),
        totalPrice(float)
    )
)
  `.trim(),
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Analyser — valid TestApp project', () => {
    let projectDir: string
    let workspace: Workspace
    let result: ReturnType<Analyser['analyse']>

    beforeAll(() => {
        projectDir = buildTestProject(VALID_TEST_APP)
        workspace = Workspace.load(projectDir)
        result = new Analyser(workspace).analyse()
    })

    it('loads all files without parse errors', () => {
        const parseErrors = workspace.allParseDiagnostics()
        console.log(parseErrors.map(e => `${e.filePath}: ${e.diagnostic.message}`))
        expect(parseErrors).toHaveLength(0)
    })

    it('indexes the system node', () => {
        expect(workspace.system).not.toBeNull()
        expect(workspace.system!.name).toBe('TestApp')
        expect(workspace.system!.modules).toEqual(['AppUIModule', 'RoutingModule', 'CatalogModule'])
    })

    it('indexes all modules', () => {
        expect(workspace.modules.has('AppUIModule')).toBe(true)
        expect(workspace.modules.has('RoutingModule')).toBe(true)
        expect(workspace.modules.has('CatalogModule')).toBe(true)
    })

    it('indexes all states in CatalogModule', () => {
        const states = workspace.states.get('CatalogModule')
        expect(states?.has('OrderDiplaying')).toBe(true)
        expect(states?.has('OrderConfirmed')).toBe(true)
        expect(states?.has('OrderCancelled')).toBe(true)
    })

    it('indexes all contexts in CatalogModule', () => {
        const contexts = workspace.contexts.get('CatalogModule')
        expect(contexts?.has('OrderContext')).toBe(true)
        expect(contexts?.has('ConfirmOrderCtx')).toBe(true)
        expect(contexts?.has('CancelOrderCtx')).toBe(true)
        expect(contexts?.has('OrderAcknowledged')).toBe(true)
    })

    it('indexes screens in CatalogModule', () => {
        const screens = workspace.screens.get('CatalogModule')
        expect(screens?.has('OrderSummaryScreen')).toBe(true)
        expect(screens?.has('OrderConfirmedScreen')).toBe(true)
        expect(screens?.has('OrderCancelledScreen')).toBe(true)
    })

    it('indexes views across modules', () => {
        expect(workspace.views.get('AppUIModule')?.has('NavigationBar')).toBe(true)
        expect(workspace.views.get('CatalogModule')?.has('OrderSummary')).toBe(true)
    })

    it('produces no semantic diagnostics for a valid project', () => {
        expect(result.diagnostics).toHaveLength(0)
    })
})

// ── Rule A001 — Undefined module ──────────────────────────────────────────────

describe('Analyser — A001: undefined module', () => {
    it('reports a module listed in system but not defined', () => {
        const dir = buildTestProject({
            'TestApp.wds': `
system TestApp (
    modules (
        AppUIModule
        MissingModule
    )
    interface (
        getContext name(string) returns(context) "desc"
        setContext name(string) value(context) "desc"
        dropContext name(string) "desc"
    )
)
      `.trim(),
            'AppUIModule/AppUIModule.wds': `module AppUIModule ()`.trim(),
        })

        const workspace = Workspace.load(dir)
        const { diagnostics } = new Analyser(workspace).analyse()
        const codes = diagnostics.map(d => d.diagnostic.code)
        expect(codes).toContain(DiagnosticCode.A_UNDEFINED_MODULE)
        const diag = diagnostics.find(d => d.diagnostic.code === DiagnosticCode.A_UNDEFINED_MODULE)
        expect(diag!.diagnostic.message).toContain('MissingModule')
    })
})

// ── Rule A002 — Undefined state in process ────────────────────────────────────

describe('Analyser — A002: undefined state in process', () => {
    it('reports a when rule referencing a state that does not exist', () => {
        const dir = buildTestProject({
            'TestApp.wds': `
system TestApp (
    modules ( AuthModule )
    interface (
        getContext name(string) returns(context) "desc"
        setContext name(string) value(context) "desc"
        dropContext name(string) "desc"
    )
)
      `.trim(),
            'AuthModule/AuthModule.wds': `
module AuthModule (
    process Auth (
        when Unauthenticated returns AccountCredentials
            enter NonExistentState "Missing state"
    )
    start Unauthenticated
)
      `.trim(),
            'AuthModule/states/Unauthenticated.wds': `
module AuthModule
state Unauthenticated (
    returns AccountCredentials
)
      `.trim(),
            'AuthModule/contexts/AccountCredentials.wds': `
module AuthModule
context AccountCredentials (
    user(string)
)
      `.trim(),
        })

        const workspace = Workspace.load(dir)
        const { diagnostics } = new Analyser(workspace).analyse()
        const codes = diagnostics.map(d => d.diagnostic.code)
        expect(codes).toContain(DiagnosticCode.A_UNDEFINED_STATE)
        const diag = diagnostics.find(d =>
            d.diagnostic.code === DiagnosticCode.A_UNDEFINED_STATE &&
            d.diagnostic.message.includes('NonExistentState')
        )
        expect(diag).toBeDefined()
    })
})

// ── Rule A003 — Undefined context in process ──────────────────────────────────

describe('Analyser — A003: undefined context in process', () => {
    it('reports a when rule referencing a context that does not exist', () => {
        const dir = buildTestProject({
            'TestApp.wds': `
system TestApp (
    modules ( AuthModule )
    interface (
        getContext name(string) returns(context) "desc"
        setContext name(string) value(context) "desc"
        dropContext name(string) "desc"
    )
)
      `.trim(),
            'AuthModule/AuthModule.wds': `
module AuthModule (
    process Auth (
        when Unauthenticated returns MissingContext
            enter Unauthenticated "loop"
    )
    start Unauthenticated
)
      `.trim(),
            'AuthModule/states/Unauthenticated.wds': `
module AuthModule
state Unauthenticated (
    returns MissingContext
)
      `.trim(),
        })

        const workspace = Workspace.load(dir)
        const { diagnostics } = new Analyser(workspace).analyse()
        const codes = diagnostics.map(d => d.diagnostic.code)
        expect(codes).toContain(DiagnosticCode.A_UNDEFINED_CONTEXT)
        const diag = diagnostics.find(d =>
            d.diagnostic.code === DiagnosticCode.A_UNDEFINED_CONTEXT &&
            d.diagnostic.message.includes('MissingContext')
        )
        expect(diag).toBeDefined()
    })
})

// ── Rule A004 — Unhandled return ──────────────────────────────────────────────

describe('Analyser — A004: unhandled return', () => {
    it('reports a context in returns with no corresponding when rule', () => {
        const dir = buildTestProject({
            'TestApp.wds': `
system TestApp (
    modules ( AuthModule )
    interface (
        getContext name(string) returns(context) "desc"
        setContext name(string) value(context) "desc"
        dropContext name(string) "desc"
    )
)
      `.trim(),
            'AuthModule/AuthModule.wds': `
module AuthModule (
    process Auth (
        when Unauthenticated returns AccountCredentials
            enter Unauthenticated "loop"
    )
    start Unauthenticated
)
      `.trim(),
            'AuthModule/states/Unauthenticated.wds': `
module AuthModule
state Unauthenticated (
    returns AccountCredentials, UnhandledContext
)
      `.trim(),
            'AuthModule/contexts/AccountCredentials.wds': `
module AuthModule
context AccountCredentials ( user(string) )
      `.trim(),
            'AuthModule/contexts/UnhandledContext.wds': `
module AuthModule
context UnhandledContext ( reason(string) )
      `.trim(),
        })

        const workspace = Workspace.load(dir)
        const { diagnostics } = new Analyser(workspace).analyse()
        const diag = diagnostics.find(d =>
            d.diagnostic.code === DiagnosticCode.A_UNHANDLED_RETURN &&
            d.diagnostic.message.includes('UnhandledContext')
        )
        expect(diag).toBeDefined()
    })
})

// ── Rule A005 — Unreachable state ─────────────────────────────────────────────

describe('Analyser — A005: unreachable state', () => {
    it('reports a state that is never entered by any when rule or start', () => {
        const dir = buildTestProject({
            'TestApp.wds': `
system TestApp (
    modules ( AuthModule )
    interface (
        getContext name(string) returns(context) "desc"
        setContext name(string) value(context) "desc"
        dropContext name(string) "desc"
    )
)
      `.trim(),
            'AuthModule/AuthModule.wds': `
module AuthModule (
    process Auth (
        when Unauthenticated returns AccountCredentials
            enter Unauthenticated "loop"
    )
    start Unauthenticated
)
      `.trim(),
            'AuthModule/states/Unauthenticated.wds': `
module AuthModule
state Unauthenticated (
    returns AccountCredentials
)
      `.trim(),
            'AuthModule/states/OrphanState.wds': `
module AuthModule
state OrphanState (
    returns AccountCredentials
)
      `.trim(),
            'AuthModule/contexts/AccountCredentials.wds': `
module AuthModule
context AccountCredentials ( user(string) )
      `.trim(),
        })

        const workspace = Workspace.load(dir)
        const { diagnostics } = new Analyser(workspace).analyse()
        const diag = diagnostics.find(d =>
            d.diagnostic.code === DiagnosticCode.A_UNREACHABLE_STATE &&
            d.diagnostic.message.includes('OrphanState')
        )
        expect(diag).toBeDefined()
    })
})

// ── Rule A006 — Invalid state.return() ───────────────────────────────────────

describe('Analyser — A006: invalid state.return()', () => {
    it('reports a state.return() referencing a context not in the state returns', () => {
        const dir = buildTestProject({
            'TestApp.wds': `
system TestApp (
    modules ( CatalogModule )
    interface (
        getContext name(string) returns(context) "desc"
        setContext name(string) value(context) "desc"
        dropContext name(string) "desc"
    )
)
      `.trim(),
            'CatalogModule/CatalogModule.wds': `
module CatalogModule (
    process Flow (
        when OrderDiplaying returns ConfirmOrderCtx
            enter OrderDiplaying "loop"
    )
    start OrderDiplaying
)
      `.trim(),
            'CatalogModule/states/OrderDiplaying.wds': `
module CatalogModule
state OrderDiplaying (
    returns ConfirmOrderCtx
    uses screen OrderSummaryScreen
)
      `.trim(),
            'CatalogModule/contexts/ConfirmOrderCtx.wds': `
module CatalogModule
context ConfirmOrderCtx ( orderId(string) )
      `.trim(),
            'CatalogModule/screens/OrderSummaryScreen.wds': `
module CatalogModule
screen OrderSummaryScreen (
    uses (
        view OrderSummary (
            onConfirm is (
                state.return(ConfirmOrderCtx)
            ),
            onCancel is (
                state.return(WrongContext)
            )
        )
    )
)
      `.trim(),
        })

        const workspace = Workspace.load(dir)
        const { diagnostics } = new Analyser(workspace).analyse()
        const diag = diagnostics.find(d =>
            d.diagnostic.code === DiagnosticCode.A_INVALID_STATE_RETURN &&
            d.diagnostic.message.includes('WrongContext')
        )
        expect(diag).toBeDefined()
    })
})

// ── Workspace — construct paths ───────────────────────────────────────────────

describe('Workspace — construct paths', () => {
    it('records the file path for each construct', () => {
        const dir = buildTestProject(VALID_TEST_APP)
        const workspace = Workspace.load(dir)

        const orderDiplayingPath = workspace.constructPaths.get('CatalogModule/OrderDiplaying')
        expect(orderDiplayingPath).toBeDefined()
        expect(orderDiplayingPath!).toContain('OrderDiplaying.wds')

        const orderContextPath = workspace.constructPaths.get('CatalogModule/OrderContext')
        expect(orderContextPath).toBeDefined()
        expect(orderContextPath!).toContain('OrderContext.wds')
    })
})
