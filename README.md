<img src="icons/wds-background.svg" width="64" height="64" align="right"/>

# WORDS Language Support

Syntax highlighting for the [WORDS specification language](https://krud-soft.github.io/words/) in VS Code.

## Features

- Syntax highlighting for `.wds` files
- Syntax highlighting for ` ```wds ` code fences in Markdown
- Bracket matching and comment toggling (`//`)

## Screenshot

(add one before publishing)

## What is WORDS?

WORDS is a behavioral specification language for describing software systems at an intermediate level between a human requirement and a working implementation — structured enough to be machine-actionable, close enough to natural language to be written and reviewed without tooling.

Learn more at [krud-soft.github.io/words](https://krud-soft.github.io/words/).

## Grammar reuse

The TextMate grammar (`syntaxes/wds.tmGrammar.json`) can be consumed independently by:

- **Shiki** — pass it as a custom language to `createHighlighter`
- **Zed** — add it as a language extension
- **GitHub Linguist** — register via `grammars.yml`

## Development

Press `F5` to launch an Extension Development Host. Open any `.wds` file or a Markdown file with a ` ```wds ` fence to see highlighting.

## License

MIT
