/**
 * client.ts
 *
 * The VS Code extension activation entry point. Spawns the WORDS language
 * server as a child process and connects to it via the LSP client.
 *
 * This file is the only piece that has a direct dependency on the VS Code
 * extension API. Everything else lives in the language server.
 */

import * as path from 'path'
import { ExtensionContext } from 'vscode'
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node'

let client: LanguageClient | undefined

/**
 * Called by VS Code when the extension is activated.
 * Creates the LSP client and starts the server process.
 */
export function activate(context: ExtensionContext): void {
    // Path to the compiled server entry point — bundled inside the extension
    const serverModule = context.asAbsolutePath(
        path.join('dist', 'server', 'server.js')
    )

    // Run the server in a separate Node.js process.
    // In debug mode, the server waits for a debugger to attach on port 6009.
    const serverOptions: ServerOptions = {
        run: {
            module: serverModule,
            transport: TransportKind.ipc,
        },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: { execArgv: ['--nolazy', '--inspect=6009'] },
        },
    }

    // Tell the client which files trigger the server
    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'wds' },
        ],
        synchronize: {
            // Notify the server when .wds files change on disk
            fileEvents: require('vscode').workspace.createFileSystemWatcher('**/*.wds'),
        },
    }

    client = new LanguageClient(
        'words-lang',
        'WORDS Language Server',
        serverOptions,
        clientOptions
    )

    // Start the client — this also launches the server process
    client.start()
}

/**
 * Called by VS Code when the extension is deactivated.
 * Stops the language server process cleanly.
 */
export function deactivate(): Thenable<void> | undefined {
    return client?.stop()
}
