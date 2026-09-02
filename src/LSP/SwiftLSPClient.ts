import * as langclient from "vscode-languageclient/node";
import * as vscode from "vscode";
import { SourceKitLSPErrorHandler } from "./SourceKitLSPErrorHandler";
import * as path from "path";
import { uriConverters } from "./uriConverters";
import { XCRunHelper } from "../Tools/XCRunHelper";
import { WorkspaceContext } from "./WorkspaceContext";
import { ProblemDiagnosticResolver } from "../ProblemDiagnosticResolver";
import { activatePeekDocuments } from "./peekDocuments";
import { activateGetReferenceDocument } from "./getReferenceDocument";
import { DefinitionProvider } from "./DefinitionProvider";

import { sleep } from "../utils";
import { exec } from "child_process";
import { kill } from "process";
import { Mutex } from "async-mutex";
import { LogChannelInterface } from "../Logs/LogChannel";
import { getFilePathInWorkspace } from "../env";
import { ActiveDocumentFeature } from "./features/ActiveDocumentFeature";
import { PeekDocumentsFeature } from "./features/PeekDocumentsFeature";
import { GetReferenceDocumentFeature } from "./features/GetReferenceDocumentFeature";

function useLspForCFamilyFiles(folder: vscode.Uri) {
    const isEnabled = vscode.workspace.getConfiguration("vscode-ios", folder).get("lsp.c_family");
    if (!isEnabled) {
        return false;
    }
    return true;
}

function checkIfThisExtensionIsFormatterByDefaultForSwiftFiles() {
    /* example of setting
        "[swift]": {
        "editor.defaultFormatter": "fireplusteam.vscode-swiftformat-xcode"
    }*/
    try {
        const config = vscode.workspace.getConfiguration();
        const swiftConfig = config.get<{ [key: string]: any }>("[swift]");
        const defaultFormatter = swiftConfig?.["editor.defaultFormatter"];
        if (defaultFormatter === "fireplusteam.vscode-ios") {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

export class SwiftLSPClient implements vscode.Disposable {
    private languageClient: langclient.LanguageClient | null | undefined;
    private mutex = new Mutex();

    private peekDocuments?: vscode.Disposable;
    private getReferenceDocument?: vscode.Disposable;
    private definitionProvider: DefinitionProvider;

    public async client(): Promise<langclient.LanguageClient> {
        const release = await this.mutex.acquire();
        try {
            if (this.languageClient === undefined) {
                const rootFolder = await this.workspaceContext.workspaceFolder;
                await this.setupLanguageClient(rootFolder);
            }
            return this.languageClient!;
        } finally {
            release();
        }
    }

    constructor(
        private readonly workspaceContext: WorkspaceContext,
        private readonly logs: vscode.OutputChannel & LogChannelInterface
    ) {
        this.definitionProvider = new DefinitionProvider(this);
        this.startMonitorMemoryUsage();
    }

    dispose() {
        this.mutex.release();

        this.peekDocuments?.dispose();
        this.getReferenceDocument?.dispose();
        this.peekDocuments?.dispose();

        this.languageClient?.stop();
    }

    public async start() {
        await this.client();
    }

    public async restart() {
        this.peekDocuments?.dispose();
        this.peekDocuments = undefined;
        this.getReferenceDocument?.dispose();
        this.getReferenceDocument = undefined;
        const client = await this.client();
        this.languageClient = undefined;
        try {
            client.stop();
            client.dispose();
            // start it again
            await this.start();
        } catch (error) {
            this.logs.error(`Swift LSP Client restarted with error ${error}`);
            if (error instanceof Error && error.message === "Stopping the server timed out") {
                await this.start(); // start a new one
            }
        }
    }

    private async setupLanguageClient(folder?: vscode.Uri) {
        const { client, errorHandler } = await this.createLSPClient(folder);
        return this.startClient(client, errorHandler);
    }

    private async createLSPClient(folder?: vscode.Uri): Promise<{
        client: langclient.LanguageClient;
        errorHandler: SourceKitLSPErrorHandler;
    }> {
        const serverPath = await XCRunHelper.sourcekitLSPPath();
        const debugOptions: { [key: string]: number | string } = {};
        if (this.logs.logLevel === "debug") {
            debugOptions["XBS_DEBUG"] = 1;
            debugOptions["XBS_LOGPATH"] = getFilePathInWorkspace(
                ".vscode/xcode/logs/xcode-build-server.log"
            );
            // to see how Xcode is using sourcekit lsp: export SOURCEKIT_LOGGING=3 && /Applications/Xcode.app/Contents/MacOS/Xcode
            //then use it in terminal: log stream --process sourcekit-lsp --debug
            // debugOptions["SOURCEKIT_LOGGING"] = 3; // LSP DEBUG PURPOSES
        }

        let workspaceFolder = undefined;
        if (folder) {
            workspaceFolder = { uri: folder, name: path.basename(folder.fsPath), index: 0 };
        }

        const sourcekit: langclient.Executable = {
            command: serverPath,
            args: [
                // this option is blocking other extensions to provide formatting on format on type even if it's not set in settings
                ...(checkIfThisExtensionIsFormatterByDefaultForSwiftFiles()
                    ? ["--experimental-feature=on-type-formatting"]
                    : []),
            ],
            options: {
                env: {
                    ...process.env,
                    XXX_BUILD_SERVER_KIT: "/SERVE",
                    ...debugOptions,
                    SOURCEKIT_TOOLCHAIN_PATH: await XCRunHelper.swiftToolchainPath(),
                },
            },
        };
        const serverOptions: langclient.ServerOptions = sourcekit;

        const documentSelector = [
            { scheme: "sourcekit-lsp", language: "swift" },
            { scheme: "file", language: "swift" },
            { scheme: "untitled", language: "swift" },
            { scheme: "file", language: "objective-c" },
            { scheme: "untitled", language: "objective-c" },
            { scheme: "file", language: "objective-cpp" },
            { scheme: "untitled", language: "objective-cpp" },
        ];
        if (folder === undefined || useLspForCFamilyFiles(folder)) {
            documentSelector.push(
                ...[
                    // C family
                    { scheme: "file", language: "c" },
                    { scheme: "untitled", language: "c" },
                    { scheme: "file", language: "cpp" },
                    { scheme: "untitled", language: "cpp" },
                ]
            );
        }
        documentSelector.push(
            ...[
                // document selector for swift-docc documentation
                { scheme: "file", language: "markdown" },
                { scheme: "untitled", language: "markdown" },
                { scheme: "file", language: "tutorial" },
                { scheme: "untitiled", language: "tutorial" },
            ]
        );

        const errorHandler = new SourceKitLSPErrorHandler(5);
        const clientOptions: langclient.LanguageClientOptions = {
            // at the moment it's empty, as it's should not be active, only used for tests parsing at the moment
            documentSelector: documentSelector,
            revealOutputChannelOn: langclient.RevealOutputChannelOn.Never,
            workspaceFolder: workspaceFolder,
            outputChannel: this.logs,
            middleware: {
                provideCompletionItem: async (document, position, context, token, next) => {
                    const result = await next(document, position, context, token);

                    if (!result) {
                        return result;
                    }

                    if (Array.isArray(result)) {
                        return addParameterHintsCommandsIfNeeded(result, document.uri);
                    }

                    return {
                        ...result,
                        items: addParameterHintsCommandsIfNeeded(result.items, document.uri),
                    };
                },
                provideCodeLenses: async (document, token, next) => {
                    const result = await next(document, token);
                    return result?.map(codelens => {
                        switch (codelens.command?.command) {
                            case "swift.run":
                                codelens.command.title = `$(play)\u00A0${codelens.command.title}`;
                                break;
                            case "swift.debug":
                                codelens.command.title = `$(debug)\u00A0${codelens.command.title}`;
                                break;
                            case "swift.play":
                                codelens.command.title = `$(play)\u00A0${codelens.command.title}`;
                                break;
                        }
                        return codelens;
                    });
                },
                provideDocumentSymbols: async (document, token, next) => {
                    try {
                        const result = await next(document, token);
                        // const documentSymbols = result as vscode.DocumentSymbol[];
                        return result;
                    } catch (error) {
                        return [];
                    }
                },
                provideDefinition: async (document, position, token, next) => {
                    const result = await next(document, position, token);
                    const definitions = result as vscode.Location[];
                    if (
                        definitions &&
                        path.extname(definitions[0].uri.path) === ".swiftinterface" &&
                        definitions[0].uri.scheme === "file"
                    ) {
                        const uri = definitions[0].uri.with({ scheme: "readonly" });
                        return new vscode.Location(uri, definitions[0].range);
                    }
                    if (
                        (result === null || result === undefined) &&
                        document.uri.fsPath.endsWith(".swift") // supports only swift files
                    ) {
                        const res = await this.definitionProvider.provide(
                            document,
                            position,
                            token
                        );
                        return res;
                    }
                    return result;
                },
                provideReferences: async (document, position, options, token, next) => {
                    const setting = "always";
                    // if (setting === "default") {
                    //     return next(document, position, options, token);
                    // }
                    return next(
                        document,
                        position,
                        { ...options, includeDeclaration: setting === "always" },
                        token
                    );
                },
                provideInlayHints: async (document, position, token, next) => {
                    const result = await next(document, position, token);
                    return result;
                },
                provideDiagnostics: async (uri, previousResultId, token, next) => {
                    const result = await next(uri, previousResultId, token);
                    if (result?.kind === langclient.vsdiag.DocumentDiagnosticReportKind.unChanged) {
                        return undefined;
                    }
                    const document = uri as vscode.TextDocument;
                    this.workspaceContext.problemDiagnosticResolver.handleDiagnostics(
                        document.uri ?? uri,
                        ProblemDiagnosticResolver.isSourcekit,
                        result?.items ?? []
                    );
                    return undefined;
                },
                handleDiagnostics: (uri, diagnostics) => {
                    this.workspaceContext.problemDiagnosticResolver.handleDiagnostics(
                        uri,
                        ProblemDiagnosticResolver.isSourcekit,
                        diagnostics
                    );
                },
                handleWorkDoneProgress: (() => {
                    // const lastPrompted = new Date(0).getTime();
                    return async (token, params, next) => {
                        const result = await next(token, params);
                        return result;
                    };
                })(),
            },
            uriConverters: uriConverters,
            errorHandler: errorHandler,
            // Avoid attempting to reinitialize multiple times. If we fail to initialize
            // we aren't doing anything different the second time and so will fail again.
            initializationFailedHandler: () => false,
            initializationOptions: await this.initializationOptions(),
        };

        const client = new langclient.LanguageClient(
            "xcode.sourcekit-lsp",
            "Xcode SourceKit Language Server",
            serverOptions,
            clientOptions
        );
        async function getSwiftVersion() {
            try {
                return await XCRunHelper.swiftToolchainVersion();
            } catch {
                return null;
            }
        }
        const swiftVersion = (await getSwiftVersion()) || ["0", "0", "0"];
        client.registerFeature(new ActiveDocumentFeature(client, swiftVersion));
        client.registerFeature(new PeekDocumentsFeature(client, swiftVersion));
        client.registerFeature(new GetReferenceDocumentFeature(client, swiftVersion));

        return {
            client: client,
            errorHandler,
        };
    }

    private async startClient(
        client: langclient.LanguageClient,
        errorHandler: SourceKitLSPErrorHandler
    ) {
        client.onDidChangeState(() => {
            // TODO: for nuw on is empty
        });

        try {
            // start client
            await client.start();
            // Now that we've started up correctly, start the error handler to auto-restart
            // if sourcekit-lsp crashes during normal operation.
            errorHandler.enable();

            this.peekDocuments = activatePeekDocuments(client);
            this.getReferenceDocument = activateGetReferenceDocument(client);
        } catch (reason) {
            this.logs.error(`Swift LSP Client started with error ${reason}`);
            this.languageClient?.stop();
            this.languageClient = undefined;
            throw reason;
        }

        this.languageClient = client;
    }

    /* eslint-disable @typescript-eslint/no-explicit-any */
    private async initializationOptions(): Promise<any> {
        const options: any = {
            "textDocument/codeLens": {
                supportedCommands: {
                    "swift.run": "swift.run",
                    "swift.debug": "swift.debug",
                    "swift.play": "swift.play",
                },
            },
        };
        // if (configuration.backgroundIndexing) {
        //     options = {
        //         ...options,
        //         backgroundIndexing: configuration.backgroundIndexing,
        //         backgroundPreparationMode: "enabled",
        //     };
        // }
        return options;
    }

    async startMonitorMemoryUsage() {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                await sleep(1000);
                await killProcessWithHighMemoryUsageOFSourceKit();
            } catch {
                /* empty */
            }
        }
    }
}

function addParameterHintsCommandsIfNeeded(
    items: vscode.CompletionItem[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    documentUri: vscode.Uri
): vscode.CompletionItem[] {
    // if (!configuration.parameterHintsEnabled(documentUri)) {
    //     return items;
    // }

    return items.map(item => {
        switch (item.kind) {
            case vscode.CompletionItemKind.Function:
            case vscode.CompletionItemKind.Method:
            case vscode.CompletionItemKind.Constructor:
            case vscode.CompletionItemKind.EnumMember:
                return {
                    command: {
                        title: "Trigger Parameter Hints",
                        command: "editor.action.triggerParameterHints",
                    },
                    ...item,
                };
            default:
                return item;
        }
    });
}

/// this's workaround to restart sourcekit-lsp if it grows really large,
/// should be fixed in swift 6.1 https://github.com/swiftlang/sourcekit-lsp/issues/1541
/// until then we use this workaround to kill it
function killProcessWithHighMemoryUsageOFSourceKit() {
    return new Promise<void>((resolve, reject) => {
        exec(`ps aux | grep 'sourcekit-lsp' | grep -v grep`, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            if (stderr) {
                reject(Error(stderr));
                return;
            }

            // Print the output which includes memory info
            // console.log(stdout);

            // Parsing stdout to find the memory usage specifically
            const lines = stdout.trim().split("\n");
            lines.forEach(line => {
                const parts = line.split(/\s+/);
                const memoryUsage = parts[5]; // %MEM column in `ps aux`
                const pid = parts[1]; // PID column in `ps aux`
                if (Number(memoryUsage) >= 2 * 1024 * 1024 && pid) {
                    kill(Number(pid), "SIGKILL");
                }
                // console.log(`PID: ${pid}, Memory Usage: ${memoryUsage}kb`);
            });
            resolve();
        });
    });
}
