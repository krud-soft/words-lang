/**
 * token.ts
 *
 * Defines every token type the WORDS lexer can produce, the Token interface
 * that carries a token's value and source location, and a convenience
 * constructor for creating tokens in tests and the lexer itself.
 */

// ── Token types ───────────────────────────────────────────────────────────────

/**
 * Every token type the WORDS lexer can produce.
 *
 * Grouped by category:
 *   - Top-level construct keywords  (system, module, state, ...)
 *   - Block keywords                (modules, props, uses, returns, ...)
 *   - Process / transition keywords (when, enter)
 *   - Control flow keywords         (if, for, as, is, is not)
 *   - Primitive types               (tstring, tinteger, ...)
 *   - Literals                      (string_lit, integer_lit, ...)
 *   - Identifiers                   (pascal_ident, camel_ident)
 *   - Punctuation                   ((, ), ,, .)
 *   - Special                       (comment, newline, eof, unknown)
 *
 * Enum values are the string representation of each token — useful for
 * readable error messages and debug output without a separate lookup table.
 *
 * Note on naming conventions: method names, callback prop names, and handler
 * method names (including names like `switch`, `onLoad`, `onSubmit`) are all
 * plain camelCase identifiers chosen by the designer. None of them are
 * reserved keywords in the WORDS language.
 */
export enum TokenType {

  // ── Top-level construct keywords ─────────────────────────────────────────
  // These keywords open a named construct body at the top level of a file
  // or inside a module definition.

  /** `system` — opens the system declaration. Appears exactly once per project. */
  System = 'system',

  /**
   * `module` — opens a module definition body, or appears alone on a line
   * as an ownership declaration at the top of component files.
   * e.g. `module AuthModule` (ownership) or `module AuthModule "..." (` (definition)
   */
  Module = 'module',

  /** `process` — opens a process definition inside a module body. */
  Process = 'process',

  /** `state` — opens a state definition. */
  State = 'state',

  /** `context` — opens a context definition. */
  Context = 'context',

  /** `screen` — opens a screen definition, or activates a screen inside a `uses` block. */
  Screen = 'screen',

  /**
   * `view` — opens a view definition, or activates a view inside a `uses` block.
   * e.g. `view LoginFormSection "..." (` or `view UIModule.LoginForm (`
   */
  View = 'view',

  /** `provider` — opens a provider definition, or activates a provider in a `uses` block. */
  Provider = 'provider',

  /**
   * `adapter` — opens an adapter definition, or activates an adapter in a `uses` block.
   * e.g. `adapter AuthAdapter.login credentials is state.context`
   */
  Adapter = 'adapter',

  /**
   * `interface` — opens an interface component definition, activates one in a
   * `uses` block, or introduces an inline interface block inside a module body.
   */
  Interface = 'interface',

  // ── Block keywords ────────────────────────────────────────────────────────
  // These keywords open named sub-blocks inside a construct body.

  /** `modules` — opens the module list inside a system body. */
  Modules = 'modules',

  /** `props` — opens the props block inside a view, provider, adapter, or interface. */
  Props = 'props',

  /** `uses` — opens the uses block inside a state, screen, view, provider, or interface. */
  Uses = 'uses',

  /**
   * `returns` — appears in two roles:
   * 1. Opens the returns clause inside a state: `returns AccountCredentials`
   * 2. Declares the return type of a method: `getProducts returns(list(Product))`
   */
  Returns = 'returns',

  /**
   * `receives` — opens the receives clause on a state definition.
   * e.g. `state Unauthenticated receives ?AuthError`
   */
  Receives = 'receives',

  /**
   * `start` — names the initial state of a module.
   * e.g. `start Unauthenticated`
   */
  Start = 'start',

  /**
   * `implements` — opens a cross-module handler implementation block
   * inside a module body.
   * e.g. `implements RoutingModule.RouteSwitchHandler (`
   */
  Implements = 'implements',

  // ── Process / transition keywords ────────────────────────────────────────

  /**
   * `when` — opens a transition rule inside a process body.
   * e.g. `when Unauthenticated returns AccountCredentials`
   */
  When = 'when',

  /**
   * `enter` — names the next state to transition to in a `when` rule
   * or an `implements` branch.
   * e.g. `enter StartAuthenticating "The user tries to authenticate"`
   */
  Enter = 'enter',

  // ── Control flow keywords ─────────────────────────────────────────────────

  /**
   * `if` — opens a conditional block inside a `uses` block or an
   * `implements` handler body.
   * e.g. `if state.context is AccountDeauthenticated (`
   */
  If = 'if',

  /**
   * `for` — opens an iteration block inside a `uses` block.
   * e.g. `for state.context.notifications as notification (`
   */
  For = 'for',

  /**
   * `as` — binds the iteration variable(s) in a `for` block.
   * For lists: `as notification` — one binding.
   * For maps:  `as category, products` — two bindings.
   */
  As = 'as',

  /**
   * `is` — the assignment and equality operator.
   * As assignment: `type is "warning"`, `path is "/home"`
   * As comparison: `if state.context is AccountDeauthenticated`
   * Context determines which role it plays.
   */
  Is = 'is',

  /**
   * `is not` — the inequality operator, normalised from the two-word
   * sequence `is not` into a single token during lexing.
   * e.g. `if state.context is not AccountRecovered`
   */
  IsNot = 'is_not',

  // ── Primitive types ───────────────────────────────────────────────────────
  // These keywords name the built-in scalar and collection types.

  /** `string` — text value type. Default: `""` */
  TString = 'tstring',

  /** `integer` — whole number type. Default: `0` */
  TInteger = 'tinteger',

  /** `float` — decimal number type. Default: `0.0` */
  TFloat = 'tfloat',

  /** `boolean` — true/false type. Default: `false` */
  TBoolean = 'tboolean',

  /**
   * `context` — opaque context type used only in the system interface
   * declaration for `getContext` and `setContext`.
   */
  TContext = 'tcontext',

  /** `list` — ordered collection type. Parameterised: `list(Product)`. Default: `[]` */
  TList = 'tlist',

  /** `map` — key-value collection type. Parameterised: `map(string, OrderSummary)`. Default: `{}` */
  TMap = 'tmap',

  // ── Literals ──────────────────────────────────────────────────────────────

  /**
   * A double-quoted string literal.
   * The token value includes the surrounding quotes.
   * e.g. `"The user authenticated successfully"`, `"/home"`
   */
  StringLit = 'string_lit',

  /**
   * A whole number literal.
   * e.g. `42`, `5000`, `0`
   */
  IntegerLit = 'integer_lit',

  /**
   * A decimal number literal.
   * e.g. `0.0`, `3.14`
   */
  FloatLit = 'float_lit',

  /**
   * A boolean literal — `true` or `false`.
   * Lexed as keyword-style tokens with value `"true"` or `"false"`.
   */
  BooleanLit = 'boolean_lit',

  // ── Identifiers ───────────────────────────────────────────────────────────

  /**
   * A PascalCase identifier — names a construct (state, context, module, etc.)
   * or a type reference.
   * e.g. `AuthModule`, `AccountCredentials`, `LoginScreen`, `Product`
   */
  PascalIdent = 'pascal_ident',

  /**
   * A camelCase identifier — names a prop, method, argument, or iteration variable.
   * This includes all designer-chosen names: callback prop names, method names,
   * and handler method names regardless of what they are called.
   * e.g. `onSubmit`, `credentials`, `fullName`, `notification`, `switch`, `onLoad`
   */
  CamelIdent = 'camel_ident',

  // ── Punctuation ───────────────────────────────────────────────────────────

  /** `(` — opens a body block or argument list. */
  LParen = '(',

  /** `)` — closes a body block or argument list. */
  RParen = ')',

  /** `,` — separates entries in a list — props, arguments, context names. */
  Comma = ',',

  /** `.` — separates parts of a qualified name or access expression. */
  Dot = '.',

  /**
   * `?` — marks an optional type or receives clause.
   * e.g. `?AuthError`, `?Product`
   * Always immediately precedes a PascalIdent.
   */
  Question = '?',

  // ── Special ───────────────────────────────────────────────────────────────

  /**
   * A `//` line comment. The token value includes the `//` prefix and
   * everything up to (but not including) the newline.
   * Comments are included in the token stream so the parser can attach
   * them to adjacent nodes for hover documentation.
   */
  Comment = 'comment',

  /**
   * A newline character `\n`.
   * Newlines are significant in WORDS for distinguishing an ownership
   * declaration (`module AuthModule` on its own line) from a construct
   * opening (`module AuthModule "..." (`).
   */
  Newline = 'newline',

  /**
   * End of file sentinel. Always the last token in the stream.
   * The parser uses this to detect unexpected end of input.
   */
  EOF = 'eof',

  /**
   * An unrecognised character. Emitted rather than throwing so the lexer
   * can continue and collect all errors in a single pass.
   */
  Unknown = 'unknown',
}

// ── Token ─────────────────────────────────────────────────────────────────────

/**
 * A single token produced by the lexer.
 *
 * `type`   — the token's category, used by the parser for matching.
 * `value`  — the raw source text that produced this token. For string
 *            literals this includes the surrounding quotes. For `is not`
 *            this is the normalised string `"is not"`.
 * `line`   — 1-based line number of the token's first character.
 * `column` — 1-based column number of the token's first character.
 * `offset` — byte offset from the start of the source string. Used by the
 *            LSP to convert between source positions and editor positions.
 */
export interface Token {
  type: TokenType
  value: string
  line: number
  column: number
  offset: number
}

// ── Convenience constructor ───────────────────────────────────────────────────

/**
 * Creates a Token with the given fields.
 * Used internally by the lexer and in tests to avoid repetitive object literals.
 */
export function token(
  type: TokenType,
  value: string,
  line: number,
  column: number,
  offset: number
): Token {
  return { type, value, line, column, offset }
}
