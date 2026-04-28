# CLAUDE.md — words-lang

Tooling for the **WORDS specification language** — a behavioral specification language for software systems. Source files use the `.wds` extension.

## Monorepo layout

```
packages/
  parser/     Lexer → AST → semantic analyser. No VS Code dependency.
  lsp/        Language server — wires parser to LSP protocol (stdio).
  extension/  VS Code extension client — spawns the LSP, provides grammar.
```

All packages are npm workspaces. The parser is the authoritative source; lsp and extension depend on it.

## Build & test

```bash
# From any package directory
npm run build          # tsc
npm run build:watch    # tsc --watch
npm test               # vitest run  (parser only — no lsp/extension tests)
npm run test:watch     # vitest

# Bundle all .wds files in a directory into a single .txt for LLM context
cd packages/parser && npm run bundle <input-dir> <output-file>

# Build the VS Code .vsix
npm run package -w packages/extension
```

Always build the parser before building the lsp (`packages/parser` → `packages/lsp`).

## Parser package (`packages/parser/src/`)

### Pipeline

```
source string
  → Lexer (lexer/lexer.ts)       flat Token[]
  → Parser (parser/parser.ts)    DocumentNode (AST)
  → Workspace (analyser/workspace.ts)  cross-file index of all constructs
  → Analyser (analyser/analyser.ts)    semantic diagnostics
```

### Lexer (`lexer/lexer.ts`, `lexer/token.ts`)

Single-pass, no regex. Emits `Newline` tokens (used by parser to detect bare ownership declarations). `is not` is fused into a single `IsNot` token. All reserved words are in the `KEYWORDS` table — every other identifier is `CamelIdent` (designer-chosen names) or `PascalIdent` (construct/type names).

Key token types: `System Module Process State Context Screen View Provider Adapter Interface Implements When Enter If For As Is IsNot Returns Receives Start Uses Props Modules LParen RParen Comma Dot PascalIdent CamelIdent StringLit IntegerLit FloatLit BooleanLit Newline Comment EOF Unknown`.

### Parser (`parser/parser.ts`)

Recursive descent. Never throws — all errors go into `this.diagnostics`. Error recovery via `synchronise()` (skips to next top-level keyword or `)`). Returns a `ParseResult` with a partial AST plus all diagnostics even on bad input.

**Ownership declaration**: a bare `module ModuleName` on its own line at the top of a component file. Captured as `document.ownerModule`.

**`parseImplements` dispatch**: after reading the method name, if `is` follows → callback form (`ImplementsCallbackNode`); otherwise → switch/if-branch form (`ImplementsHandlerNode`).

**`parseStatement` dispatch for `state.return`**:
- `state.return PascalIdent [( args )]` → new inline-construction form; `contextName` = the PascalIdent
- `state.return(camelIdent)` → old arg-binding form; `contextName` = the camelIdent

### AST (`parser/ast.ts`)

Every node has `kind` (discriminant) and `token` (first token, for diagnostics/LSP). Key unions:

| Union | Members |
|---|---|
| `TopLevelNode` | `System Module State Context Screen View Provider Adapter Interface` |
| `ReturnsNode` | `SimpleReturns ExpandedReturns` |
| `ExpressionNode` | `AccessExpression CallExpression StateReturnExpression BlockExpression` + literals |
| `StatementNode` | `AssignmentStatement StateReturnStatement` |
| `UseEntryNode` | `ComponentUse ConditionalBlock IterationBlock` |

**`ModuleNode.implements`** is `(ImplementsHandlerNode | ImplementsCallbackNode)[]` — distinguish by `impl.kind`.

**`StateReturnStatementNode`** has `inlineContext: InlineContextNode | null`. Non-null when the new `state.return ContextType ( args )` form is used.

**`ImplementsCallbackNode`** has `methodName: string` and `enterActions: ImplementsEnterActionNode[]`. Each action has `targetState`, `contextType` (from `context is X`), and `inlineContext`.

### Workspace (`analyser/workspace.ts`)

Scans a project directory, parses every `.wds` file, and builds a flat index organised by module:

```typescript
workspace.modules       // Map<moduleName, ModuleNode>
workspace.states        // Map<moduleName, Map<stateName, StateNode>>
workspace.contexts      // Map<moduleName, Map<contextName, ContextNode>>
workspace.screens       // Map<moduleName, Map<screenName, ScreenNode>>
workspace.views         // Map<moduleName, Map<viewName, ViewNode>>
workspace.adapters      // Map<moduleName, Map<adapterName, AdapterNode>>
workspace.providers     // Map<moduleName, Map<providerName, ProviderNode>>
workspace.interfaces    // Map<moduleName, Map<interfaceName, InterfaceNode>>
workspace.constructPaths // Map<"ModuleName/ConstructName", filePath>
workspace.modulePaths   // Map<moduleName, filePath>
```

### Analyser (`analyser/analyser.ts`)

Rules run over the Workspace index in order. All emit `Diagnostic` objects — nothing is thrown.

| Code | Rule |
|---|---|
| A001 | State referenced in `when` rule or `start` exists |
| A002 | Context referenced in `when` rule exists |
| A003 | Context in `returns` has a corresponding `when` rule |
| A004 | Every defined state is reachable |
| A005 | Module listed in `system.modules` has a definition |
| A006 | Component referenced by qualified name exists |
| A007 | Ownership declaration matches construct's module |
| A008 | `state.return(x)` context is in the state's `returns` |
| A009 | `implements` references a declared interface |
| A010 | `state.return(x)` arg name matches the handler prop's declared arg |
| A011 | Adapter use argument names match the method's declared parameters |
| A012 | Inline context construction includes all required fields |

**A008/A010 disambiguation**: if `contextName` starts with an uppercase letter OR `inlineContext != null`, it is a direct context type reference → check against `validReturns` (A008). If `contextName` is camelCase and the prop has an `argName`, it is an arg-binding form → check against `argName` (A010).

### Diagnostic codes (`analyser/diagnostics.ts`)

`P001–P011` are parse errors. `A001–A012` are semantic errors. `W001–W002` are warnings. `H_*` are hints.

## LSP package (`packages/lsp/src/`)

`server.ts` — entry point, creates an LSP connection over stdin/stdout.

`connection.ts` (`WordsConnection`) — handles the full lifecycle:
- `onInitialize` — scans workspace root, loads Workspace
- `onDidSave` / `onDidOpen` — reloads changed file, re-runs Analyser, pushes diagnostics to client
- `onDefinition` — resolves cursor → token → construct name → `constructPaths` lookup → `Location`

Go-to-definition supports: state, context, screen, view, provider, adapter, interface, process, and cross-module qualified names (`Module.ConstructName`).

## WORDS language constructs

The nine construct keywords and their roles:

| Keyword | Role |
|---|---|
| `system` | Root — names the app, lists modules, declares system interface methods |
| `module` | Organisational unit — owns processes, start state, `implements` blocks, subscriptions |
| `process` | Transition map — `when State returns Context enter NextState "narrative"` rules |
| `state` | Behavioral unit — `receives` context on entry, declares `returns`, `uses` screen |
| `context` | Typed data flowing between states — named fields with types |
| `screen` | Top-level UI; has access to `state.context` and `state.return()` |
| `view` | Reusable rendering component; receives all data via `props`, no state access |
| `provider` | In-memory derived data; never does I/O; exposes named methods |
| `adapter` | I/O boundary; the only async construct; exposes named methods |
| `interface` | Typed contract — data model, helper, handler shape, or callable |

### Key syntax patterns

```wds
// Ownership declaration (component files)
module ModuleName
state StateName receives ContextName ( ... )

// Process transition
when CurrentState returns ProducedContext
    enter NextState "narrative" ( inlineArgs? )

// Implements — switch/branch form
implements Module.Interface (
    methodName paramName(Type) (
        if param is value
            enter State "narrative"
    )
)

// Implements — callback form (direct enter)
implements Module.ListenerInterface (
    methodName is (
        enter State context is ContextType (
            field is value
        )
    )
)

// State return in screen callback — old arg-binding form
onConfirm is ( state.return(argName) )

// State return in screen callback — new inline-construction form
onLogout is (
    state.return ContextType (
        field is value
    )
)

// Expanded returns with side effects
returns (
    ContextName (
        system.setContext name is ContextName, value is state.context
    )
)
```

### Type system

Primitives: `string integer float boolean context`. Parameterised: `list(Type)` `map(KeyType, ValueType)`. Named types are PascalCase interface component references. `?Type` marks optional.

### Qualified names

`Module.Construct` for cross-module references. `state.context`, `state.context.field` for state access. `system.methodName(...)` for system interface calls. `AdapterName.methodName` for adapter uses.

## File conventions

- One construct per `.wds` file (states, screens, contexts, views, etc.)
- Module definition file at `ModuleName/ModuleName.wds`
- System file at the project root, named after the system
- Subdirectories by construct kind: `states/` `screens/` `contexts/` `views/` `adapters/` `providers/` `interfaces/`
- Component files start with a bare `module ModuleName` ownership declaration

## Common development patterns

**Adding a new AST node**: add interface to `ast.ts`, import in `parser.ts`, add to relevant union type, add parser method, update any analyser rules that walk that part of the tree.

**Adding an analyser rule**: add `DiagnosticCode` entry in `diagnostics.ts`, add private `check*` method in `analyser.ts`, call it from `analyse()`.

**Extending an existing node**: add the field with `| null` default to avoid breaking existing construction sites; update the parser method to populate it; update any analyser or LSP code that needs to read it.

**Tests**: all tests live in `packages/parser/tests/`. Parser tests use inline source strings. Analyser tests use `buildTestProject()` to write temp files. Run with `npm test` from `packages/parser/`.
