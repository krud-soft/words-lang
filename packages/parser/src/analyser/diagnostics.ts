/**
 * diagnostics.ts
 *
 * Defines the Diagnostic type returned by the parser and analyser.
 * Diagnostics are never thrown — they are collected and returned alongside
 * the AST so the caller always receives the fullest possible picture of
 * what the source contains, even when it is malformed.
 *
 * The LSP server maps these directly to VS Code diagnostics, using the
 * `range` to underline the offending token in the editor.
 */

// ── Severity ──────────────────────────────────────────────────────────────────

/**
 * The severity of a diagnostic.
 *
 * `error`   — the source is invalid and cannot produce a correct implementation.
 *             e.g. a `when` rule referencing a state that has no definition.
 * `warning` — the source is valid but likely wrong or incomplete.
 *             e.g. a process narrative omitted where one is strongly recommended.
 * `hint`    — a stylistic or structural suggestion.
 *             e.g. a module with no description.
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'hint'

// ── Source position ───────────────────────────────────────────────────────────

/**
 * A zero-based line and character position in the source.
 * Matches the LSP `Position` type so diagnostics can be forwarded
 * to VS Code without translation.
 */
export interface Position {
    /** Zero-based line number. */
    line: number
    /** Zero-based character offset within the line. */
    character: number
}

/**
 * A start-inclusive, end-exclusive range in the source.
 * Matches the LSP `Range` type.
 */
export interface Range {
    start: Position
    end: Position
}

// ── Diagnostic codes ──────────────────────────────────────────────────────────

/**
 * Every diagnostic code the parser and analyser can produce.
 * Codes are namespaced by layer:
 *   P_* — parse errors (structural / syntactic problems)
 *   A_* — analyser errors (semantic problems)
 *   W_* — warnings
 *   H_* — hints
 */
export enum DiagnosticCode {

    // ── Parse errors ────────────────────────────────────────────────────────────

    /** An unexpected token was encountered where a specific token was required. */
    P_UNEXPECTED_TOKEN = 'P001',

    /** The source ended before the construct was complete. */
    P_UNEXPECTED_EOF = 'P002',

    /** An opening `(` was not matched by a closing `)`. */
    P_UNCLOSED_PAREN = 'P003',

    /** A string literal was opened with `"` but never closed. */
    P_UNCLOSED_STRING = 'P004',

    /** A construct keyword was found in a position where it is not valid. */
    P_INVALID_CONSTRUCT_POSITION = 'P005',

    /** A `when` rule is missing its `enter` clause. */
    P_MISSING_ENTER = 'P006',

    /** A `when` rule is missing its `returns` clause. */
    P_MISSING_RETURNS = 'P007',

    /** A type annotation `(Type)` was expected but not found. */
    P_MISSING_TYPE = 'P008',

    /** An identifier (PascalCase or camelCase) was expected but not found. */
    P_MISSING_IDENTIFIER = 'P009',

    /** An `is` keyword was expected in an argument assignment but not found. */
    P_MISSING_IS = 'P010',

    // ── Analyser errors ─────────────────────────────────────────────────────────

    /**
     * A state referenced in a `when` rule or `start` declaration has no
     * corresponding state definition in the module's directory.
     */
    A_UNDEFINED_STATE = 'A001',

    /**
     * A context referenced in a `when` rule, `receives`, or `returns` clause
     * has no corresponding context definition in the module's directory.
     */
    A_UNDEFINED_CONTEXT = 'A002',

    /**
     * A context listed in a state's `returns` block has no corresponding
     * `when` rule in any of the module's processes.
     */
    A_UNHANDLED_RETURN = 'A003',

    /**
     * A state is defined but never referenced in any process `when` rule
     * and is not the module's `start` state.
     */
    A_UNREACHABLE_STATE = 'A004',

    /**
     * A module listed in the system's `modules` block has no corresponding
     * module definition file.
     */
    A_UNDEFINED_MODULE = 'A005',

    /**
     * A component referenced by qualified name (e.g. `UIModule.LoginForm`)
     * cannot be resolved — either the module does not exist or the component
     * is not defined within it.
     */
    A_UNDEFINED_COMPONENT = 'A006',

    /**
     * The owning module declared at the top of a component file (e.g.
     * `module AuthModule`) does not match the module the construct names itself.
     */
    A_MODULE_MISMATCH = 'A007',

    /**
     * A `state.return(contextName)` call references a context name that does
     * not appear in the enclosing state's `returns` clause.
     */
    A_INVALID_STATE_RETURN = 'A008',

    /**
     * An `implements` block references a handler interface that is not declared
     * in the named module.
     */
    A_UNDEFINED_INTERFACE = 'A009',

    // ── Warnings ────────────────────────────────────────────────────────────────

    /**
     * A `when` rule has no transition narrative.
     * Narratives are optional but strongly recommended for readability.
     */
    W_MISSING_NARRATIVE = 'W001',

    /**
     * A construct has no description string.
     * Descriptions are optional but recommended for documentation.
     */
    W_MISSING_DESCRIPTION = 'W002',

    // ── Hints ────────────────────────────────────────────────────────────────────

    /**
     * A state has no `uses` block — it is a transient state that holds a
     * position in the process map while something external resolves.
     * This is valid but worth flagging so the designer is aware.
     */
    H_EMPTY_USES = 'H001',
}

// ── Diagnostic ────────────────────────────────────────────────────────────────

/**
 * A single diagnostic produced by the parser or analyser.
 *
 * `code`     — the diagnostic code, used by the LSP to deduplicate and
 *              provide quick-fix suggestions.
 * `message`  — a human-readable explanation of the problem.
 * `severity` — how serious the problem is.
 * `range`    — the source range to underline in the editor. Derived from
 *              the offending token's line, column, and value length.
 * `source`   — identifies which layer produced the diagnostic:
 *              `'parser'` for structural problems, `'analyser'` for semantic ones.
 */
export interface Diagnostic {
    code: DiagnosticCode
    message: string
    severity: DiagnosticSeverity
    range: Range
    source: 'parser' | 'analyser'
}

// ── Convenience constructors ──────────────────────────────────────────────────

/**
 * Creates a Range from a 1-based line and column and the length of the
 * offending text. Converts to the zero-based LSP convention internally.
 */
export function rangeFromToken(line: number, column: number, length: number): Range {
    return {
        start: { line: line - 1, character: column - 1 },
        end: { line: line - 1, character: column - 1 + length },
    }
}

/**
 * Creates a parser-layer Diagnostic.
 */
export function parseDiagnostic(
    code: DiagnosticCode,
    message: string,
    severity: DiagnosticSeverity,
    range: Range
): Diagnostic {
    return { code, message, severity, range, source: 'parser' }
}

/**
 * Creates an analyser-layer Diagnostic.
 */
export function analyserDiagnostic(
    code: DiagnosticCode,
    message: string,
    severity: DiagnosticSeverity,
    range: Range
): Diagnostic {
    return { code, message, severity, range, source: 'analyser' }
}
