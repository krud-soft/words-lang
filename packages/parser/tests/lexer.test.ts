import { describe, it, expect } from 'vitest'
import { Lexer } from '../src/lexer/lexer'
import { TokenType } from '../src/lexer/token'

describe('Lexer', () => {

    it('tokenizes a bare module ownership declaration', () => {
        const tokens = new Lexer('module AuthModule').tokenize()
        expect(tokens[0].type).toBe(TokenType.Module)
        expect(tokens[1].type).toBe(TokenType.PascalIdent)
        expect(tokens[1].value).toBe('AuthModule')
        expect(tokens[2].type).toBe(TokenType.EOF)
    })

    it('tokenizes a state declaration with optional receives', () => {
        const src = 'state Unauthenticated receives ?AuthError'
        const tokens = new Lexer(src).tokenize()
        expect(tokens[0].type).toBe(TokenType.State)
        expect(tokens[1].type).toBe(TokenType.PascalIdent)
        expect(tokens[1].value).toBe('Unauthenticated')
        expect(tokens[2].type).toBe(TokenType.Receives)
        expect(tokens[3].type).toBe(TokenType.Question)
        expect(tokens[4].type).toBe(TokenType.PascalIdent)
        expect(tokens[4].value).toBe('AuthError')
    })

    it('tokenizes "is not" as a single IsNot token', () => {
        const tokens = new Lexer('if state.context is not AccountRecovered').tokenize()
        const isNot = tokens.find(t => t.type === TokenType.IsNot)
        expect(isNot).toBeDefined()
        expect(isNot!.value).toBe('is not')
    })

    it('tokenizes a string literal', () => {
        const tokens = new Lexer('"Hello world"').tokenize()
        expect(tokens[0].type).toBe(TokenType.StringLit)
        expect(tokens[0].value).toBe('"Hello world"')
    })

    it('tokenizes a line comment', () => {
        const tokens = new Lexer('// this is a comment').tokenize()
        expect(tokens[0].type).toBe(TokenType.Comment)
        expect(tokens[0].value).toBe('// this is a comment')
    })

    it('tokenizes integer and float literals', () => {
        const tokens = new Lexer('42 3.14').tokenize()
        expect(tokens[0].type).toBe(TokenType.IntegerLit)
        expect(tokens[0].value).toBe('42')
        expect(tokens[1].type).toBe(TokenType.FloatLit)
        expect(tokens[1].value).toBe('3.14')
    })

    it('tokenizes builtin types', () => {
        const tokens = new Lexer('string integer float boolean list map').tokenize()
        expect(tokens[0].type).toBe(TokenType.TString)
        expect(tokens[1].type).toBe(TokenType.TInteger)
        expect(tokens[2].type).toBe(TokenType.TFloat)
        expect(tokens[3].type).toBe(TokenType.TBoolean)
        expect(tokens[4].type).toBe(TokenType.TList)
        expect(tokens[5].type).toBe(TokenType.TMap)
    })

    it('tracks line and column positions', () => {
        const src = 'module AuthModule\nstate Unauthenticated'
        const tokens = new Lexer(src).tokenize()
        expect(tokens[0].line).toBe(1)
        expect(tokens[0].column).toBe(1)
        // 'state' is on line 2
        const stateToken = tokens.find(t => t.type === TokenType.State)
        expect(stateToken?.line).toBe(2)
    })

    it('tokenizes a when rule', () => {
        const src = 'when Unauthenticated returns AccountCredentials'
        const tokens = new Lexer(src).tokenize()
        expect(tokens[0].type).toBe(TokenType.When)
        expect(tokens[1].type).toBe(TokenType.PascalIdent)
        expect(tokens[1].value).toBe('Unauthenticated')
        expect(tokens[2].type).toBe(TokenType.Returns)
        expect(tokens[3].type).toBe(TokenType.PascalIdent)
        expect(tokens[3].value).toBe('AccountCredentials')
    })

    it('tokenizes punctuation correctly', () => {
        const tokens = new Lexer('( ) , .').tokenize()
        expect(tokens[0].type).toBe(TokenType.LParen)
        expect(tokens[1].type).toBe(TokenType.RParen)
        expect(tokens[2].type).toBe(TokenType.Comma)
        expect(tokens[3].type).toBe(TokenType.Dot)
    })

    it('tokenizes a full state block', () => {
        const src = `
module AuthModule
state Unauthenticated receives ?AuthError (
    returns AccountCredentials
    uses screen LoginScreen
)
    `.trim()
        const tokens = new Lexer(src).tokenize()
        const types = tokens.map(t => t.type)
        expect(types).toContain(TokenType.Module)
        expect(types).toContain(TokenType.State)
        expect(types).toContain(TokenType.Receives)
        expect(types).toContain(TokenType.Question)
        expect(types).toContain(TokenType.Returns)
        expect(types).toContain(TokenType.Uses)
        expect(types).toContain(TokenType.Screen)
    })

})
