| <img src="packages/extension/icons/wds-background.png" width="45" height="45"/> | words-lang |
|---|---|

Tooling for the [WORDS specification language](https://krud-soft.github.io/words/) — a behavioral specification language for describing software systems at an intermediate level between a human requirement and a working implementation.

## Packages

| Package | Description |
|---|---|
| [`packages/extension`](packages/extension) | VS Code extension — syntax highlighting, diagnostics, and go-to-definition for `.wds` files |
| [`packages/parser`](packages/parser) | Standalone lexer, parser, and semantic analyser — reusable outside VS Code |
| [`packages/lsp`](packages/lsp) | Language server — wires the parser to the LSP protocol |

## VS Code Extension

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=KRUDSoftware.words-lang) or search for **WORDS Specification Language** in the Extensions panel.

Features:
- Syntax highlighting for `.wds` files and ` ```wds ` code fences in Markdown
- Diagnostics — invalid specs flagged in the Problems panel
- Go-to-definition — navigate to state, context, screen, and view definitions
- Bracket matching and comment toggling (`//`)

## Parser Library

The `@words-lang/parser` package is a standalone TypeScript library with no VS Code dependency. It can be used independently to parse and validate WORDS specifications.
```typescript
import { Workspace, Analyser } from '@words-lang/parser'

const workspace = Workspace.load('./my-words-project')
const { diagnostics } = new Analyser(workspace).analyse()
```

The TextMate grammar (`packages/extension/syntaxes/wds.tmGrammar.json`) is a standard portable format compatible with Shiki, Zed, and GitHub Linguist.

## Development
```bash
# Install dependencies
npm install

# Build all packages
cd packages/parser && npm run build
cd packages/lsp && npm run build
cd packages/extension && npm run build

# Run tests
cd packages/parser && npm test

# Launch Extension Development Host
# Open the repo in VS Code and press F5
```

## Project Structure
```
words-lang/
  packages/
    extension/    VS Code extension client + grammars + icons
    lsp/          Language server (diagnostics, go-to-definition)
    parser/       Lexer, parser, AST, semantic analyser, workspace
```

## License

MIT — [KRUD Software](https://github.com/krud-soft)
