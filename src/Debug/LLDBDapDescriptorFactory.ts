import { exec } from "child_process";
import { resolve } from "path";
import * as vscode from "vscode";

/**
 * This class defines a factory used to find the lldb-dap binary to use
 * depending on the session configuration.
 */
export class LLDBDapDescriptorFactory
    implements vscode.DebugAdapterDescriptorFactory {

    constructor() {
    }

    static async isValidDebugAdapterPath(
        pathUri: vscode.Uri,
    ): Promise<Boolean> {
        try {
            const fileStats = await vscode.workspace.fs.stat(pathUri);
            if (!(fileStats.type & vscode.FileType.File)) {
                return false;
            }
        } catch (err) {
            return false;
        }
        return true;
    }

    async createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined,
    ): Promise<vscode.DebugAdapterDescriptor | undefined> {
        const path = await LLDBDapDescriptorFactory.getXcodeDebuggerExePath();
        if (path == null) {
            LLDBDapDescriptorFactory.showLLDBDapNotFoundMessage();
            return undefined;
        }

        const log_path = null; // TODO: add log path to extension settings
        let env: { [key: string]: string } = {};
        if (log_path) {
            env["LLDBDAP_LOG"] = log_path;
        }

        // const configEnvironment = config.get<{ [key: string]: string }>("lldb.environment") || {};
        if (path) {
            const dbgOptions = {
                env: {
                    // ...configEnvironment,
                    ...env,
                }
            };
            return new vscode.DebugAdapterExecutable(path, [], dbgOptions);
        } else if (executable) {
            return new vscode.DebugAdapterExecutable(
                executable.command,
                executable.args,
                {
                    ...executable.options,
                    env: {
                        ...executable.options?.env,
                        // ...configEnvironment,
                        ...env,
                    },
                },
            );
        } else {
            return undefined;
        }
    }

    static async getXcodeDebuggerExePath() {
        try {
            const path = await LLDBDapDescriptorFactory.getLLDBDapPath();
            const fileUri = vscode.Uri.file(path);
            const majorSwiftVersion = Number((await LLDBDapDescriptorFactory.swiftToolchainVersion())[0]);
            // starting swift 6, lldb-dap is included in swift toolchain, so use is
            if (majorSwiftVersion >= 6 && (await LLDBDapDescriptorFactory.isValidDebugAdapterPath(fileUri))) {
                return path;
            }
            return null;
        } catch {
            return null;
        }
    }
    /**
     * Shows a message box when the debug adapter's path is not found
     */
    static async showLLDBDapNotFoundMessage() {
        const openSettingsAction = "Reload VS Code";
        const callbackValue = await vscode.window.showErrorMessage(
            `Xcode Debug adapter is not valid. Please make sure that Xcode is installed and restart VS Code!`,
            openSettingsAction,
        );

        if (openSettingsAction === callbackValue) {
            vscode.commands.executeCommand(
                "workbench.action.reloadWindow",
            );
        }
    }

    private static async getLLDBDapPath(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            exec("xcrun -find lldb-dap", (error, stdout) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(stdout.trim());
                }
            })
        });
    }

    static async swiftToolchainVersion(): Promise<[string, string, string]> {
        return new Promise((resolve, reject) => {
            exec("xcrun swift --version", (error, stdout) => {
                if (error) {
                    reject(error);
                } else {
                    const versionPattern = /swiftlang-([0-9]+)?.([0-9]+)?.([0-9]+)?/g;
                    const version = [...stdout.matchAll(versionPattern)]?.[0];
                    if (version) {
                        resolve([version[1], version[2], version[3]]);
                    } else {
                        reject(new Error("swift lang is not determined"));
                    }
                }
            })
        });
    }
}