# words-lang

Syntax highlighting for the WORDS specification language (`.wds` files) and ` ```wds ` code fences in Markdown.

## What's inside

| File | Purpose |
|---|---|
| `syntaxes/wds.tmGrammar.json` | The TextMate grammar — the reusable artifact |
| `syntaxes/wds.markdown-injection.json` | Injects the grammar into Markdown code fences |
| `package.json` | VS Code extension manifest |
| `language-configuration.json` | Bracket matching, comment toggling |

## Development

Press `F5` in VS Code to launch an Extension Development Host with the grammar loaded. Open any `.wds` file or a `.md` file containing ` ```wds ` fences to see highlighting.

## Packaging

```bash
npm install -g @vscode/vsce
vsce package
# produces words-lang-0.1.0.vsix
```

Install in VS Code via **Extensions → ··· → Install from VSIX**.

## Using the grammar elsewhere

The file `syntaxes/wds.tmGrammar.json` is a standard TextMate grammar and can be consumed directly by:

- **Shiki** — pass it as a custom language to `createHighlighter`
- **Zed** — add it as a language extension
- **GitHub Linguist** — register via `grammars.yml`
