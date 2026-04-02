/**
 * server.ts
 *
 * Entry point for the WORDS language server. This file is spawned as a
 * child process by the VS Code extension client. It creates the LSP
 * connection over stdin/stdout and delegates all protocol handling to
 * the WordsConnection class.
 *
 * The server never imports VS Code APIs directly — it communicates
 * exclusively through the LSP protocol, making it editor-agnostic.
 */

import { createConnection, ProposedFeatures } from 'vscode-languageserver/node'
import { WordsConnection } from './connection'

// Create the LSP connection over Node's stdin/stdout IPC transport.
// ProposedFeatures enables semantic tokens and other draft LSP features.
const connection = createConnection(ProposedFeatures.all)

// Wire all protocol handlers through the connection wrapper.
new WordsConnection(connection).listen()
