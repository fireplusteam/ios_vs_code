import {
    spawn,
    ChildProcess,
    SpawnOptions,
} from "child_process";
import { getEnv, getScriptPath, getWorkspacePath } from "./env";
import * as vscode from "vscode";
import { killAll } from "./utils";
import { CommandContext, UserTerminatedError } from "./CommandManagement/CommandContext";
import { error } from "console";

export class ExecutorTerminated extends Error {
    public constructor(message: string) {
        super(message);
    }
}

export class ExecutorRunningError extends Error {
    commandName: string | undefined;
    public constructor(message: string, commandName: string | undefined) {
        super(message);
        this.commandName = commandName;
    }
}

export class ExecutorTaskError extends Error {
    code: number | null;
    terminal: vscode.Terminal | null;
    public constructor(message: string, code: number | null, terminal: vscode.Terminal | null) {
        super(message);
        this.code = code;
        this.terminal = terminal;
    }
}

export enum ExecutorReturnType {
    statusCode,
    stdout
}

export enum ExecutorMode {
    verbose,
    silently
}

export class Executor {
    private _executingCommand: string | undefined;
    private terminal: vscode.Terminal | undefined;
    private writeEmitter: vscode.EventEmitter<string> | undefined;
    private changeNameEmitter: vscode.EventEmitter<string> | undefined;
    private childProc: ChildProcess | undefined;
    private animationInterval: NodeJS.Timeout | undefined;

    private onExit = new vscode.EventEmitter<void>();

    public get executingCommand(): string | undefined {
        return this._executingCommand;
    }

    get isRunning(): boolean {
        return this.childProc != undefined;
    }

    public constructor() { }

    createTitleAnimation(terminalId: string) {
        // animation steps
        const steps = ["\\", "|", "/", "-"];
        let currentIndex = 0;
        // start the animation
        const animationInterval = setInterval(() => {
            currentIndex = (currentIndex + 1) % steps.length;
            this.changeNameEmitter?.fire(`${steps[currentIndex]} ${terminalId}`);
        }, 1000); // Change this to control animation speed
        return animationInterval;
    }

    private getTerminalName(id: string) {
        const terminalId = `iOS: ${id}`;
        return terminalId;
    }

    private getTerminal(id: string) {
        const terminalId = this.getTerminalName(id);
        clearInterval(this.animationInterval);
        this.animationInterval = this.createTitleAnimation(terminalId);
        if (this.terminal) {
            if (this.terminal.name === terminalId) {
                return this.terminal;
            }
            this.changeNameEmitter?.fire(`${terminalId}`);
            return this.terminal;
        }
        this.writeEmitter = new vscode.EventEmitter<string>();
        this.changeNameEmitter = new vscode.EventEmitter<string>();
        const pty: vscode.Pseudoterminal = {
            onDidWrite: this.writeEmitter.event,
            onDidChangeName: this.changeNameEmitter.event,
            open: () => this.writeEmitter?.fire(`\x1b[31${terminalId}\x1b[0m`),
            close: () => {
                this.terminal = undefined;
                this.onExit.fire();
            },
        };
        this.terminal = vscode.window.createTerminal({
            name: terminalId,
            pty: pty,
        });
        return this.terminal;
    }

    private terminateShellImp(proc: ChildProcess) {
        if (this.childProc !== proc) {
            console.warn("Try to terminate wrong process");
        }
        clearInterval(this.animationInterval);
        this.animationInterval = undefined;
        this.childProc = undefined;
        this._executingCommand = undefined;
        this.onExit.fire();
    }

    private execShellImp(
        file: string,
        args: ReadonlyArray<string>,
        options: SpawnOptions
    ) {
        const quotedArgs = args.map((e) => {
            return `"${e}"`;
        });
        return spawn(file, quotedArgs, options);
    }

    private dataToPrint(data: string) {
        data = data.replaceAll("\n", "\n\r");
        return data;
    }

    public async execShell(
        cancellationToken: vscode.CancellationToken | undefined,
        commandName: string | "shellScript",
        fileOrCommand: string,
        args: string[] = [],
        showTerminal = false,
        returnType = ExecutorReturnType.statusCode,
        mode: ExecutorMode = ExecutorMode.verbose
    ): Promise<boolean | string> {
        if (cancellationToken && cancellationToken.isCancellationRequested) {
            throw Promise.reject(UserTerminatedError);
        }
        if (this.isRunning) {
            throw Promise.reject(new ExecutorRunningError("Another task is running", this._executingCommand));
        }
        const env = getEnv();
        const envOptions = {
            ...process.env,
            ...env,
        };
        let script: string = fileOrCommand;
        if (commandName != "shellScript") {
            script = getScriptPath(fileOrCommand);
            if (script.indexOf(".py") !== -1) {
                script = `python3 "${script}"`;
            }
        }
        const proc = this.execShellImp(script, args, {
            cwd: getWorkspacePath(),
            shell: true,
            env: envOptions,
            stdio: "pipe",
        });
        this._executingCommand = commandName;
        this.childProc = proc;
        const terminal = mode === ExecutorMode.silently ? null : this.getTerminal(commandName);
        if (showTerminal) {
            terminal?.show();
        }
        if (mode === ExecutorMode.verbose) {
            this.writeEmitter?.fire(`COMMAND: ${commandName}\n`);
        }
        let stdout = "";
        proc.stdout?.on("data", (data) => {
            if (mode === ExecutorMode.verbose) {
                this.writeEmitter?.fire(this.dataToPrint(data.toString()));
            }
            if (returnType === ExecutorReturnType.stdout) {
                stdout += data.toString();
            }
        });
        proc.stderr?.on("data", (data) => {
            if (mode === ExecutorMode.verbose) {
                this.writeEmitter?.fire(this.dataToPrint(data.toString()));
            }
        });

        return new Promise((resolve, reject) => {
            let userCancel: vscode.Disposable | undefined;
            let terminalClose: vscode.Disposable | undefined;
            userCancel = cancellationToken?.onCancellationRequested(() => {
                userCancel?.dispose();
                terminalClose?.dispose();
                reject(UserTerminatedError);
                if (proc.killed || proc.exitCode != null || proc.signalCode != null || this.childProc != proc)
                    return;

                this.terminateShellImp(proc);
                if (mode !== ExecutorMode.silently) {
                    this.changeNameEmitter?.fire(
                        `🚫 ${this.getTerminalName(commandName)}`
                    );
                }
                killAll(proc.pid, "SIGKILL");
            });
            terminalClose = this.onExit.event(() => {
                userCancel?.dispose();
                terminalClose?.dispose();
                reject(UserTerminatedError);
                if (proc.killed || proc.exitCode != null || proc.signalCode != null || this.childProc != proc)
                    return;

                this.terminateShellImp(proc);
                killAll(proc.pid, "SIGKILL");
            });

            proc.once("error", (err) => {
                userCancel?.dispose();
                terminalClose.dispose();
                if (this.childProc !== proc) {
                    console.log("Error, wrong child process error")
                    return;
                }
                this.terminateShellImp(proc);
                reject(err);
            });

            proc.once("exit", (code, signal) => {
                userCancel?.dispose();
                terminalClose?.dispose();

                if (this.childProc !== proc) {
                    console.log("Error, wrong child process terminated")
                    return;
                }
                this.terminateShellImp(proc)

                if (signal !== null) {
                    if (mode !== ExecutorMode.silently) {
                        this.changeNameEmitter?.fire(
                            `❌ ${this.getTerminalName(commandName)}`
                        );
                    }
                    reject(new ExecutorTerminated(`${this.getTerminalName(commandName)} is terminated with SIGNAL : ${error}`));
                    return;
                }

                if (mode === ExecutorMode.verbose) {
                    this.writeEmitter?.fire(
                        this.dataToPrint(`${this.getTerminalName(commandName)} exits with status code: ${code}\n`)
                    );
                }
                if (code !== 0) {
                    if (mode !== ExecutorMode.silently) {
                        this.changeNameEmitter?.fire(
                            `❌ ${this.getTerminalName(commandName)}`
                        );
                    }
                    reject(
                        new ExecutorTaskError(
                            `Task: ${this.getTerminalName(commandName)} exits with ${code}`,
                            code,
                            terminal
                        )
                    );
                } else {
                    if (mode !== ExecutorMode.silently) {
                        this.changeNameEmitter?.fire(
                            `✅ ${this.getTerminalName(commandName)}`
                        );
                    }
                    switch (returnType) {
                        case ExecutorReturnType.statusCode:
                            resolve(true);
                            break;
                        case ExecutorReturnType.stdout:
                            resolve(stdout);
                            break;
                    }
                }
            });
        });
    }
}
