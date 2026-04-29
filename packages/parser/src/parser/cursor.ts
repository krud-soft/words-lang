import { Token, TokenType } from '../lexer/token'
import {
    Diagnostic,
    DiagnosticCode,
    parseDiagnostic,
    rangeFromToken,
} from '../analyser/diagnostics'

/**
 * ParserCursor owns token-stream mechanics for the recursive-descent parser.
 *
 * Grammar methods should ask this object where they are, consume expected
 * tokens, skip trivia, and report parse diagnostics. Keeping that machinery
 * here lets parser.ts focus on WORDS grammar rules.
 */
export class ParserCursor {
    private tokens: Token[]
    private pos: number = 0
    readonly diagnostics: Diagnostic[] = []

    constructor(tokens: Token[]) {
        this.tokens = tokens
    }

    get position(): number {
        return this.pos
    }

    set position(pos: number) {
        this.pos = pos
    }

    /** Returns the token at the current position. */
    current(): Token {
        return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1]
    }

    /** Returns true if the current token has the given type. */
    check(type: TokenType): boolean {
        return this.current().type === type
    }

    /** Consumes and returns the current token, advancing the position. */
    advance(): Token {
        const tok = this.current()
        if (tok.type !== TokenType.EOF) this.pos++
        return tok
    }

    /**
     * Consumes the current token if it matches `type` and returns it.
     * If it does not match, emits a diagnostic and returns null without advancing.
     */
    expect(type: TokenType): Token | null {
        if (this.check(type)) return this.advance()
        const tok = this.current()
        this.error(
            DiagnosticCode.P_UNEXPECTED_TOKEN,
            `Expected '${type}' but found '${tok.value}'`,
            tok
        )
        return null
    }

    /** Consumes a PascalIdent or CamelIdent and returns its value. */
    expectIdent(context: string): string {
        if (this.check(TokenType.PascalIdent) || this.check(TokenType.CamelIdent)) {
            return this.advance().value
        }
        const tok = this.current()
        this.error(
            DiagnosticCode.P_MISSING_IDENTIFIER,
            `Expected identifier (${context}) but found '${tok.value}'`,
            tok
        )
        return '?'
    }

    /**
     * Consumes and returns the string value if the current token is a StringLit.
     * Returns null without advancing if it is not.
     */
    parseOptionalString(): string | null {
        if (this.check(TokenType.StringLit)) {
            const val = this.advance().value
            return val.slice(1, -1)
        }
        return null
    }

    /**
     * Skips tokens until the closing ')' that matches the '(' already consumed.
     * Used for local recovery inside type annotations.
     */
    syncToClosingParen(): void {
        let depth = 0
        while (!this.check(TokenType.EOF)) {
            if (this.check(TokenType.LParen)) {
                depth++
                this.advance()
                continue
            }
            if (this.check(TokenType.RParen)) {
                if (depth === 0) {
                    this.advance()
                    return
                }
                depth--
            }
            this.advance()
        }
    }

    /** Skips comment tokens only. */
    skipComments(): void {
        while (this.check(TokenType.Comment)) this.advance()
    }

    /** Skips comments and newlines between meaningful tokens. */
    skipTrivia(): void {
        while (this.check(TokenType.Comment) || this.check(TokenType.Newline)) this.advance()
    }

    /**
     * Returns true if the first non-trivia token after the current position
     * is a CamelIdent.
     */
    peekPastTriviaIsCamelIdent(): boolean {
        let i = this.pos + 1
        while (i < this.tokens.length) {
            const t = this.tokens[i]
            if (t.type === TokenType.Newline || t.type === TokenType.Comment) {
                i++
                continue
            }
            return t.type === TokenType.CamelIdent
        }
        return false
    }

    /**
     * Returns true if the current two tokens form a `[` `]` list literal.
     * The lexer currently emits bracket characters as Unknown tokens.
     */
    checkListLiteral(): boolean {
        return (
            this.current().type === TokenType.Unknown &&
            this.current().value === '[' &&
            this.tokens[this.pos + 1]?.value === ']'
        )
    }

    /** Returns true if the current two tokens form a `{` `}` map literal. */
    checkMapLiteral(): boolean {
        return (
            this.current().type === TokenType.Unknown &&
            this.current().value === '{' &&
            this.tokens[this.pos + 1]?.value === '}'
        )
    }

    /** Emits a diagnostic at the given token's position. */
    error(code: DiagnosticCode, message: string, tok: Token): void {
        const range = rangeFromToken(tok.line, tok.column, tok.value.length || 1)
        this.diagnostics.push(parseDiagnostic(code, message, 'error', range))
    }

    /**
     * Advances past tokens until a safe synchronisation point is found.
     * Synchronisation points: top-level keyword, closing paren, or EOF.
     */
    synchronise(): void {
        while (!this.check(TokenType.EOF)) {
            switch (this.current().type) {
                case TokenType.System:
                case TokenType.Module:
                case TokenType.State:
                case TokenType.Context:
                case TokenType.Screen:
                case TokenType.View:
                case TokenType.Provider:
                case TokenType.Adapter:
                case TokenType.Interface:
                case TokenType.RParen:
                    return
                default:
                    this.advance()
            }
        }
    }
}
