| <img src="https://raw.githubusercontent.com/krud-soft/words-lang/main/packages/extension/icons/wds-background.png" width="45" height="45"/> | WORDS Language Support |
|---|---|

Syntax highlighting for the [WORDS specification language](https://krud-soft.github.io/words/) in VS Code.

> **Work in progress.** This extension is experimental and not yet production-ready. Expect rough edges and missing functionality.

## Features

- Syntax highlighting for `.wds` files
- Syntax highlighting for ` ```wds ` code fences in Markdown
- Bracket matching and comment toggling (`//`)
- Diagnostics — invalid specs are flagged in the Problems panel
- Go-to-definition — navigate to state, context, screen, and view definitions

## Screenshot

![WORDS syntax highlighting](https://raw.githubusercontent.com/krud-soft/words-lang/main/packages/extension/images/words-screen-01.png)

## What is WORDS?

WORDS is a behavioral specification language for describing software systems at an intermediate level between a human requirement and a working implementation — structured enough to be machine-actionable, close enough to natural language to be written and reviewed without tooling.

Learn more at [krud-soft.github.io/words](https://krud-soft.github.io/words/).

## Requirements

VS Code 1.74 or later. Node.js is bundled with VS Code so no separate installation is needed.

## Grammar reuse

The TextMate grammar (`syntaxes/wds.tmGrammar.json`) can be consumed independently by:

- **Shiki** — pass it as a custom language to `createHighlighter`
- **Zed** — add it as a language extension
- **GitHub Linguist** — register via `grammars.yml`

## Development

Press `F5` to launch an Extension Development Host. Open any `.wds` file or a Markdown file with a ` ```wds ` fence to see highlighting.

## License

MIT