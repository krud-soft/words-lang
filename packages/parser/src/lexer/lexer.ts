/**
 * lexer.ts
 *
 * The WORDS lexer. Converts a raw `.wds` source string into a flat array
 * of tokens that the parser consumes.
 *
 * Design principles:
 *
 * - Single-pass, character-by-character. No regular expressions at runtime —
 *   all character classification is done with simple comparisons.
 *
 * - Never throws. Unrecognised characters are emitted as `Unknown` tokens so
 *   the parser can continue and collect all errors in one pass rather than
 *   stopping at the first problem.
 *
 * - `is not` is normalised into a single `IsNot` token during lexing.
 *   This simplifies the parser — it never has to handle a two-token sequence
 *   in conditional expressions.
 *
 * - Newlines are emitted as `Newline` tokens. The parser uses them to
 *   distinguish a bare ownership declaration (`module AuthModule` on its own
 *   line) from a construct body opening (`module AuthModule "..." (`).
 *
 * - Comments are included in the token stream (not silently discarded) so the
 *   parser can attach them to adjacent nodes for hover documentation.
 *
 * - Callback prop names such as `onLoad`, `onSubmit`, `onConfirm` are plain
 *   camelCase identifiers — they carry no special meaning to the lexer. The
 *   parser interprets them purely from their position in the token stream.
 *
 * - Position tracking (line, column, offset) is maintained for every token
 *   so the LSP can report diagnostics and resolve go-to-definition requests
 *   at the exact source location.
 */

import { Token, TokenType, token } from './token'

// ── Keyword table ─────────────────────────────────────────────────────────────

/**
 * Maps every reserved word in WORDS to its token type.
 * Identifiers not found in this table are classified as PascalIdent or
 * CamelIdent based on their first character.
 *
 * Note: `true` and `false` are listed here so they are never accidentally
 * emitted as plain identifiers.
 *
 * Callback prop names (`onLoad`, `onSubmit`, `onConfirm`, etc.) are
 * intentionally NOT in this table — they are user-defined camelCase names
 * and must be treated as plain CamelIdent tokens.
 */
const KEYWORDS: Record<string, TokenType> = {
    system: TokenType.System,
    module: TokenType.Module,
    process: TokenType.Process,
    state: TokenType.State,
    context: TokenType.Context,
    screen: TokenType.Screen,
    view: TokenType.View,
    provider: TokenType.Provider,
    adapter: TokenType.Adapter,
    interface: TokenType.Interface,
    modules: TokenType.Modules,
    props: TokenType.Props,
    uses: TokenType.Uses,
    returns: TokenType.Returns,
    receives: TokenType.Receives,
    start: TokenType.Start,
    implements: TokenType.Implements,
    when: TokenType.When,
    enter: TokenType.Enter,
    switch: TokenType.Switch,
    if: TokenType.If,
    for: TokenType.For,
    as: TokenType.As,
    is: TokenType.Is,
    true: TokenType.BooleanLit,
    false: TokenType.BooleanLit,
    string: TokenType.TString,
    integer: TokenType.TInteger,
    float: TokenType.TFloat,
    boolean: TokenType.TBoolean,
    list: TokenType.TList,
    map: TokenType.TMap,
}

// ── Lexer class ───────────────────────────────────────────────────────────────

export class Lexer {
    /** The full source text being tokenized. */
    private source: string

    /** Current byte offset into `source`. */
    private pos: number = 0

    /** Current 1-based line number. Incremented each time a `\n` is consumed. */
    private line: number = 1

    /**
     * Current 1-based column number.
     * Reset to 1 after each newline; incremented after each other character.
     */
    private column: number = 1

    /** Accumulated token stream. Populated by `tokenize()`. */
    private tokens: Token[] = []

    constructor(source: string) {
        this.source = source
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Tokenizes the entire source string and returns the token stream.
     * The last token in the stream is always an `EOF` token.
     *
     * Calling `tokenize()` more than once on the same instance returns a new
     * stream from scratch (internal state is reset on construction, not here —
     * create a new Lexer for each source string).
     */
    tokenize(): Token[] {
        while (!this.isAtEnd()) {
            // Skip horizontal whitespace between tokens.
            // Newlines are NOT skipped here — they are emitted as Newline tokens.
            this.skipWhitespace()
            if (this.isAtEnd()) break

            const start = this.pos
            const startLine = this.line
            const startCol = this.column
            const ch = this.current()

            // ── Line comment ─────────────────────────────────────────────────────
            if (ch === '/' && this.peek(1) === '/') {
                const comment = this.readLineComment()
                this.tokens.push(token(TokenType.Comment, comment, startLine, startCol, start))
                continue
            }

            // ── String literal ───────────────────────────────────────────────────
            if (ch === '"') {
                const str = this.readString()
                this.tokens.push(token(TokenType.StringLit, str, startLine, startCol, start))
                continue
            }

            // ── Number literal ───────────────────────────────────────────────────
            // Integers and floats are distinguished by the presence of a decimal point.
            if (this.isDigit(ch)) {
                const num = this.readNumber()
                const type = num.includes('.') ? TokenType.FloatLit : TokenType.IntegerLit
                this.tokens.push(token(type, num, startLine, startCol, start))
                continue
            }

            // ── Identifier or keyword ────────────────────────────────────────────
            if (this.isAlpha(ch) || ch === '_') {
                const ident = this.readIdent()

                // Special case: 'is not' — look ahead past any whitespace to see if
                // the next word is 'not'. If so, consume it and emit a single IsNot
                // token. This keeps the parser free from two-token handling in conditions.
                if (ident === 'is') {
                    const savedPos = this.pos
                    const savedLine = this.line
                    const savedCol = this.column
                    this.skipWhitespace()
                    if (
                        this.source.startsWith('not', this.pos) &&
                        !this.isAlphaNumeric(this.source[this.pos + 3] ?? '')
                    ) {
                        this.pos += 3
                        this.column += 3
                        this.tokens.push(token(TokenType.IsNot, 'is not', startLine, startCol, start))
                        continue
                    }
                    // Not 'is not' — restore position and emit plain Is.
                    this.pos = savedPos
                    this.line = savedLine
                    this.column = savedCol
                }

                // Look up keyword table; fall through to identifier classification.
                const kwType = KEYWORDS[ident]
                if (kwType !== undefined) {
                    this.tokens.push(token(kwType, ident, startLine, startCol, start))
                } else if (/^[A-Z]/.test(ident)) {
                    // PascalCase → construct name or type reference
                    this.tokens.push(token(TokenType.PascalIdent, ident, startLine, startCol, start))
                } else {
                    // camelCase → prop name, method name, callback name, or iteration variable.
                    // This includes onLoad, onSubmit, onConfirm, and all other callback props.
                    this.tokens.push(token(TokenType.CamelIdent, ident, startLine, startCol, start))
                }
                continue
            }

            // ── Optional marker ──────────────────────────────────────────────────
            // `?` always immediately precedes a PascalCase type name.
            if (ch === '?') {
                this.advance()
                this.tokens.push(token(TokenType.Question, '?', startLine, startCol, start))
                continue
            }

            // ── Punctuation ──────────────────────────────────────────────────────
            if (ch === '(') { this.advance(); this.tokens.push(token(TokenType.LParen, '(', startLine, startCol, start)); continue }
            if (ch === ')') { this.advance(); this.tokens.push(token(TokenType.RParen, ')', startLine, startCol, start)); continue }
            if (ch === ',') { this.advance(); this.tokens.push(token(TokenType.Comma, ',', startLine, startCol, start)); continue }
            if (ch === '.') { this.advance(); this.tokens.push(token(TokenType.Dot, '.', startLine, startCol, start)); continue }

            // ── Newline ──────────────────────────────────────────────────────────
            // Emitted as a token so the parser can detect line boundaries.
            // The line counter is incremented inside `advance()`.
            if (ch === '\n') {
                this.tokens.push(token(TokenType.Newline, '\n', startLine, startCol, start))
                this.advance()
                continue
            }

            // ── Unknown ──────────────────────────────────────────────────────────
            // Emit and continue rather than throwing, so all errors can be collected.
            this.tokens.push(token(TokenType.Unknown, ch, startLine, startCol, start))
            this.advance()
        }

        // EOF sentinel — always the last token.
        this.tokens.push(token(TokenType.EOF, '', this.line, this.column, this.pos))
        return this.tokens
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /**
     * Returns the character at the current position without consuming it.
     * Returns an empty string if at end of input.
     */
    private current(): string {
        return this.source[this.pos] ?? ''
    }

    /**
     * Returns the character at `pos + offset` without consuming it.
     * Used for one-character lookahead (e.g. distinguishing `//` from `/`).
     * Returns an empty string if the offset is out of bounds.
     */
    private peek(offset: number): string {
        return this.source[this.pos + offset] ?? ''
    }

    /**
     * Consumes the current character, advances the position, and updates
     * line/column tracking. Returns the consumed character.
     * Line is incremented and column reset to 1 when a `\n` is consumed.
     */
    private advance(): string {
        const ch = this.source[this.pos]
        if (ch === '\n') {
            this.line++
            this.column = 1
        } else {
            this.column++
        }
        this.pos++
        return ch ?? ''
    }

    /** Returns true when all characters have been consumed. */
    private isAtEnd(): boolean {
        return this.pos >= this.source.length
    }

    /** Returns true for ASCII decimal digit characters. */
    private isDigit(ch: string): boolean {
        return ch >= '0' && ch <= '9'
    }

    /** Returns true for ASCII letters and underscore. */
    private isAlpha(ch: string): boolean {
        return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
    }

    /** Returns true for characters valid inside an identifier (letters, digits, underscore). */
    private isAlphaNumeric(ch: string): boolean {
        return this.isAlpha(ch) || this.isDigit(ch)
    }

    /**
     * Advances past spaces, tabs, and carriage returns.
     * Newlines are NOT skipped — they are significant and emitted as tokens.
     */
    private skipWhitespace(): void {
        while (!this.isAtEnd()) {
            const ch = this.current()
            if (ch === ' ' || ch === '\t' || ch === '\r') {
                this.advance()
            } else {
                break
            }
        }
    }

    /**
     * Reads a `//` line comment from the current position to the end of the line.
     * The returned value includes the `//` prefix.
     * The terminating `\n` is NOT consumed — it will be emitted as a Newline token
     * on the next iteration.
     */
    private readLineComment(): string {
        let result = ''
        while (!this.isAtEnd() && this.current() !== '\n') {
            result += this.advance()
        }
        return result
    }

    /**
     * Reads a double-quoted string literal from the current position.
     * Handles backslash escape sequences by consuming both the `\` and the
     * following character as a unit.
     * The returned value includes the surrounding quotes.
     * Unclosed strings (EOF before closing `"`) are returned as-is — the
     * parser will report the error from context.
     */
    private readString(): string {
        let result = '"'
        this.advance() // consume opening quote
        while (!this.isAtEnd() && this.current() !== '"') {
            if (this.current() === '\\') {
                result += this.advance() // backslash
                result += this.advance() // escaped character
            } else {
                result += this.advance()
            }
        }
        if (!this.isAtEnd()) {
            result += this.advance() // consume closing quote
        }
        return result
    }

    /**
     * Reads an integer or float literal from the current position.
     * A decimal point followed by at least one digit triggers float mode.
     * The returned string is the raw source text — conversion to a number
     * happens in the parser.
     */
    private readNumber(): string {
        let result = ''
        while (!this.isAtEnd() && this.isDigit(this.current())) {
            result += this.advance()
        }
        // Check for decimal point followed by a digit — if so, continue as float.
        if (!this.isAtEnd() && this.current() === '.' && this.isDigit(this.peek(1))) {
            result += this.advance() // consume '.'
            while (!this.isAtEnd() && this.isDigit(this.current())) {
                result += this.advance()
            }
        }
        return result
    }

    /**
     * Reads an identifier (keyword or user-defined name) from the current position.
     * Identifiers consist of letters, digits, and underscores.
     * The caller is responsible for classifying the result via the keyword table.
     */
    private readIdent(): string {
        let result = ''
        while (!this.isAtEnd() && this.isAlphaNumeric(this.current())) {
            result += this.advance()
        }
        return result
    }
}
