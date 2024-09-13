import { exec } from "child_process";
import * as vscode from "vscode";
import { InteractiveTerminal } from "./InteractiveTerminal";

export class ToolsManager {
    private log: vscode.OutputChannel;
    private terminal: InteractiveTerminal


    constructor(log: vscode.OutputChannel) {
        this.log = log;
        this.terminal = new InteractiveTerminal(log, "Install Dependencies");
    }

    private async isToolInstalled(name: string, version = "--version"): Promise<boolean> {
        return new Promise((resolve,) => {
            const command = `${name} ${version}`;
            this.log.appendLine(command);
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    this.log.appendLine(stderr);
                    resolve(false);
                }
                else {
                    this.log.appendLine(stdout);
                    resolve(true);
                }
            });
        });
    }

    private isGemInstalled(gemName: string): Promise<boolean> {
        // return new Promise(resolve => { resolve(false) });
        return new Promise((resolve,) => {
            const command = `gem list ^${gemName}$ -i`;
            this.log.appendLine(command);
            exec(command, (error, stdout, stderr) => {
                this.log.appendLine(`stderr: ${stderr}`);
                this.log.appendLine(`stdout: ${stdout}`);
                if (error) {
                    resolve(false);
                } else {
                    // stdout returns a boolean as a string, either 'true' or 'false'
                    const isInstalled = stdout.trim() === 'true';
                    resolve(isInstalled);
                }
            });
        });
    }

    private async isHomebrewInstalled() {
        return await this.isToolInstalled("brew");
    }

    private async isXcbeautifyInstalled() {
        return await this.isToolInstalled("xcbeautify");
    }

    private async isRubyInstalled() {
        return await this.isToolInstalled("ruby", "-v");
    }

    private async installHomebrew() {
        const installScript = `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`;
        this.terminal.show();
        await this.terminal.executeCommand(installScript);
    };

    private async installTool(name: string, toolName = "brew") {
        const command = `${toolName} install ${name}`;
        this.terminal.show();
        await this.terminal.executeCommand(command);
    }

    private async installTools() {
        if (!(await this.isHomebrewInstalled())) {
            await this.installHomebrew();
        }

        if (!(await this.isXcbeautifyInstalled())) {
            await this.installTool("xcbeautify");
        }

        if (!(await this.isRubyInstalled())) {
            await this.installTool("ruby");
        }

        if (!(await this.isGemInstalled("xcodeproj"))) {
            await this.installTool("xcodeproj", "gem");
        }
    }

    public async updateThirdPartyTools() {
        this.terminal.show();
        try {
            await this.installTools();
            await this.terminal.executeCommand("brew update");
            await this.terminal.executeCommand("brew upgrade xcbeautify");
            await this.terminal.executeCommand("brew upgrade ruby");
            await this.terminal.executeCommand("gem install xcodeproj");
        } catch (error) {
            this.log.appendLine(`Dependencies were not updated, error: ${error}`);
            vscode.window.showErrorMessage("Dependencies were not updated. Try again or do it manually");
            throw error;
        }
    }

    public async resolveThirdPartyTools(askUserToInstallDeps: boolean = false) {
        this.log.appendLine("Resolving Third Party Dependencies");
        if (!(await this.isHomebrewInstalled())
            || !(await this.isXcbeautifyInstalled())
            || !(await this.isRubyInstalled())
            || !(await this.isGemInstalled("xcodeproj"))) {
            let option: string | undefined = "Yes";
            if (!askUserToInstallDeps)
                option = await vscode.window.showWarningMessage("Required tools are not installed. Without them extension would not work properly. Do you want to Install Them automatically?", "Yes", "No");
            if (option == "Yes") {
                try {
                    // install extensions
                    await this.installTools();
                    this.log.appendLine("All dependencies are installed. You are ready to go");
                } catch (err) {
                    this.log.appendLine(`Dependencies were not installed: ${err}.\r\n This extensions would not be working as expected!`);
                    throw new Error(`Dependencies were not installed: ${err}.\r\n This extensions would not be working as expected!`);
                }
            } else {
                this.log.appendLine("Dependencies are not installed. This extensions would not be working as expected!")
                throw new Error("Dependencies are not installed. Extension would not be working properly");
            }
        } else {
            this.log.appendLine("All dependencies are installed. You are ready to go");
        }
    }
}