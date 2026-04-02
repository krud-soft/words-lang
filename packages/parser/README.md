# @words-lang/parser

![WORDS](https://raw.githubusercontent.com/krud-soft/words-lang/main/packages/extension/icons/wds-background.png)

Standalone lexer, parser, and semantic analyser for the [WORDS specification language](https://krud-soft.github.io/words/).

Part of the [words-lang](https://github.com/krud-soft/words-lang) tooling monorepo.

## Installation
```bash
npm install @words-lang/parser
```

## Usage

### Parse a single file
```typescript
import { Lexer, Parser } from '@words-lang/parser'
import * as fs from 'fs'

const source = fs.readFileSync('MyModule/states/Unauthenticated.wds', 'utf-8')
const tokens = new Lexer(source).tokenize()
const { document, diagnostics } = new Parser(tokens).parse()
```

### Analyse a full project
```typescript
import { Workspace, Analyser } from '@words-lang/parser'

const workspace = Workspace.load('./my-words-project')
const { diagnostics } = new Analyser(workspace).analyse()

for (const { filePath, diagnostic } of diagnostics) {
  console.log(`${filePath} [${diagnostic.code}] ${diagnostic.message}`)
}
```

### Diagnostic codes

| Code | Layer | Description |
|---|---|---|
| `P001` | Parser | Unexpected token |
| `P002` | Parser | Unexpected end of file |
| `A001` | Analyser | Module listed in system has no definition |
| `A002` | Analyser | State referenced in process has no definition |
| `A003` | Analyser | Context referenced in process has no definition |
| `A004` | Analyser | Context in returns has no corresponding when rule |
| `A005` | Analyser | State is never entered |
| `A006` | Analyser | state.return() references an undeclared context |
| `A007` | Analyser | Ownership declaration does not match construct module |

## What is WORDS?

WORDS is a behavioral specification language for describing software systems at an intermediate level between a human requirement and a working implementation — structured enough to be machine-actionable, close enough to natural language to be written and reviewed without tooling.

Full documentation at [krud-soft.github.io/words](https://krud-soft.github.io/words/).

## License

MIT