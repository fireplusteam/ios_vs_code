import { exec } from 'child_process';
import { glob } from 'glob';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProblemDiagnosticResolver } from './ProblemDiagnosticResolver';
import { ProjectManager, getProjectFiles } from './ProjectManager/ProjectManager';
import { buildSelectedTarget } from "./buildCommands";
import { currentPlatform, getBundleAppName, getDeviceId, getEnvList, getMultiDeviceIds, getProjectConfiguration, getProjectPath, getProjectScheme, getScriptPath, getWorkspacePath, getXCBBuildServicePath, Platform, ProjectEnv, updateProject } from "./env";
import { Executor, ExecutorMode } from "./execShell";
import { sleep } from './extension';
import { QuickPickItem, showPicker } from "./inputPicker";
import { emptyAppLog, getLastLine, isFolder } from "./utils";
import { CommandContext } from './CommandManagement/CommandContext';
import { RunManager } from './Services/RunManager';

function filterDevices(devices: { [name: string]: string }[], isSelected: (device: { [name: string]: string }) => boolean) {
    const items = devices.map<QuickPickItem | undefined>(device => {
        let formattedKey = "";
        if (device.hasOwnProperty("name") && device.hasOwnProperty("OS"))
            formattedKey = `${device["name"]} - OS ${device["OS"]} `;
        else if (device.hasOwnProperty("name"))
            formattedKey = device["name"];
        else if (device.hasOwnProperty("platform"))
            formattedKey = device["platform"];
        else return undefined;
        if (device.hasOwnProperty("variant")) {
            formattedKey += " " + device["variant"];
        }

        if (isSelected(device)) {
            return { label: "$(notebook-state-success) " + formattedKey, picked: true, value: device };
        } else {
            return { label: formattedKey, value: device }
        }
    }).filter((item): item is QuickPickItem => item !== undefined);
    return items;
}

export async function selectProjectFile(commandContext: CommandContext, projectManager: ProjectManager, showProposalMessage = false, ignoreFocusOut = false) {
    const workspaceEnd = ".xcworkspace/contents.xcworkspacedata";
    const projectEnd = ".xcodeproj/project.pbxproj";
    const excludeEnd = ".xcodeproj/project.xcworkspace"
    const include: vscode.GlobPattern = `**/{*${workspaceEnd},*${projectEnd},Package.swift}`;
    const files = await glob(
        include,
        {
            absolute: true,
            cwd: getWorkspacePath(),
            nodir: true
        }
    );

    const options = files
        .filter(file => {
            if (file.endsWith(projectEnd)) {
                for (let checkFile of files) {
                    if (checkFile.endsWith(workspaceEnd) &&
                        checkFile.slice(0, -workspaceEnd.length) == file.slice(0, -projectEnd.length))
                        return false;
                }
            }
            return true;
        })
        .map((file) => {
            if (file.endsWith("Package.swift")) {
                const relativeProjectPath = path.relative(getWorkspacePath(), file)
                return { label: relativeProjectPath, value: file };
            }
            const relativeProjectPath = path.relative(getWorkspacePath(), file)
                .split(path.sep)
                .slice(0, -1)
                .join(path.sep);
            return { label: relativeProjectPath, value: file.split(path.sep).slice(0, -1).join(path.sep) };
        })
        .filter(file => {
            if (file.value.endsWith(excludeEnd))
                return false;
            return true;
        });
    if (options.length == 0) {
        if (showProposalMessage == false) {
            vscode.window.showErrorMessage("Workspace doesn't have any iOS project or workspace file");
        }
        return false;
    } else if (showProposalMessage) {
        const isAllowedToConfigure = await vscode.window.showInformationMessage("Workspace has iOS projects. Do you want to pick a project to configure?", "Yes", "No");
        if (isAllowedToConfigure !== "Yes")
            return false;
    }

    const selection = await showPicker(
        options,
        "Select Project File",
        "Please select your project file",
        false,
        ignoreFocusOut,
        true
    );
    if (selection === undefined || selection === '') {
        return false;
    }
    await updateProject(commandContext.projectSettingsProvider.projectEnv, selection);
    await projectManager.loadProjectFiles(true);
    await checkWorkspace(commandContext, true);
    return true;
}

export async function selectTarget(commandContext: CommandContext, ignoreFocusOut = false) {
    const schemes = await commandContext.projectSettingsProvider.getSchemes();
    const currentScheme = await commandContext.projectSettingsProvider.projectEnv.projectScheme;
    const json = JSON.stringify(schemes.map(scheme => {
        if (currentScheme == scheme)
            return { label: "$(notebook-state-success) " + scheme, value: scheme };
        else return { label: scheme, value: scheme };
    }));

    let option = await showPicker(json,
        "Target",
        "Please select Target",
        false,
        ignoreFocusOut,
        true
    );

    if (option === undefined) {
        return;
    }
    await commandContext.projectSettingsProvider.projectEnv.setProjectScheme(option);
}

export async function selectConfiguration(commandContext: CommandContext, ignoreFocusOut = false) {
    const configurations = await commandContext.projectSettingsProvider.getConfigurations();
    const currentConfiguration = await commandContext.projectSettingsProvider.projectEnv.projectConfiguration;
    const json = JSON.stringify(configurations.map(configuration => {
        if (currentConfiguration == configuration)
            return { label: "$(notebook-state-success) " + configuration, value: configuration };
        else return { label: configuration, value: configuration };
    }));

    let option = await showPicker(json,
        "Configuration",
        "Please Select Build Configuration",
        false,
        ignoreFocusOut,
        true
    );

    if (option === undefined) {
        return;
    }

    await commandContext.projectSettingsProvider.projectEnv.setProjectConfiguration(option);
}

export async function selectDevice(commandContext: CommandContext, shouldCheckWorkspace = true, ignoreFocusOut = false) {

    const devices = await commandContext.projectSettingsProvider.getDevices();
    const selectedDeviceID = await commandContext.projectSettingsProvider.projectEnv.debugDeviceID;
    const items = filterDevices(devices, device => selectedDeviceID == device["id"]);

    if (items.length == 0) {
        vscode.window.showErrorMessage("There're no available devices to select for given scheme/project configuration. Likely, need to install simulators first!");
        return false;
    }

    let option = await showPicker(
        items,
        "Device",
        "Please select Device for DEBUG",
        false,
        ignoreFocusOut,
        true
    );

    if (option === undefined) {
        return false;
    }
    if (typeof option == "object") {
        const obj = option as { [key: string]: any };
        await commandContext.projectSettingsProvider.projectEnv.setDebugDeviceID(obj.id)
        await commandContext.projectSettingsProvider.projectEnv.setPlatform(obj.platform);
    }
}

export async function restartLSP() {
    await vscode.commands.executeCommand("swift.restartLSPServer");
}

export async function checkWorkspace(commandContext: CommandContext, ignoreFocusOut = false) {
    await selectTarget(commandContext, ignoreFocusOut);
    await selectConfiguration(commandContext, ignoreFocusOut);
    await selectDevice(commandContext, false, ignoreFocusOut)
}

export async function generateXcodeServer(commandContext: CommandContext) {
    await checkWorkspace(commandContext);
    await commandContext.execShell(
        "Generate xCode Server",
        { file: "build_autocomplete.sh" }
    );
}

export async function openXCode(activeFile: string) {
    const openExec = new Executor();
    const stdout = (await openExec.execShell({
        terminalName: "Open Xcode",
        scriptOrCommand: { file: "open_xcode.sh" },
        args: [await getProjectPath()],
        mode: ExecutorMode.silently
    })).stdout;
    console.log(stdout);
    if (!isFolder(activeFile)) {
        exec(`open - a Xcode ${activeFile} `);
    }
}

export async function runApp(commandContext: CommandContext, sessionID: string, isDebuggable: boolean) {
    const runManager = new RunManager(
        sessionID,
        isDebuggable,
        new ProjectEnv()
    );
    await runManager.runOnDebugDevice(commandContext);
}

export async function runAppOnMultipleDevices(commandContext: CommandContext, sessionID: string, problemResolver: ProblemDiagnosticResolver) {
    if (await currentPlatform() == Platform.macOS) {
        vscode.window.showErrorMessage("MacOS Platform doesn't support running on Multiple Devices");
        return;
    }

    const devices = await commandContext.projectSettingsProvider.getDevices();
    const selectedDeviceID = (await commandContext.projectSettingsProvider.projectEnv.multipleDeviceID).split(" |").map(device => device.substring("id=".length));

    const items = filterDevices(devices, device => selectedDeviceID.find(id => device["id"] == id) !== undefined);

    if (items.length == 0) {
        vscode.window.showErrorMessage("There're no available devices to select for given scheme/project configuration. Likely, need to install simulators first!");
        return false;
    }

    const option = await showPicker(
        items,
        "Devices",
        "Please select Multiple Devices to Run You App",
        true,
        false,
        true
    );

    if (option === undefined || option === '') {
        return;
    }

    const projectEvn = new ProjectEnv();

    const deviceIds: string[] = [];
    if (Array.isArray(option)) {
        for (const device of option)
            deviceIds.push(device.id);
        commandContext.projectSettingsProvider.projectEnv.setMultipleDeviceID(
            deviceIds.map(device => `id=${device}`).join(" |")
        );
    }

    await buildSelectedTarget(commandContext, problemResolver);

    for (let device of deviceIds) {
        emptyAppLog(device);
    }
    const runApp = new RunManager(
        sessionID,
        false,
        projectEvn
    );
    await runApp.runOnMultipleDevices(commandContext);
}

export async function runAndDebugTests(commandContext: CommandContext, sessionID: string, isDebuggable: boolean) {
    await commandContext.execShell(
        "Run Tests",
        { file: "test_app.sh" },
        [sessionID, isDebuggable ? "DEBUG_LLDB" : "RUNNING", "-ALL"],
    );
}

export async function runAndDebugTestsForCurrentFile(commandContext: CommandContext, sessionID: string, isDebuggable: boolean, tests: string[]) {
    const option = tests.map(e => {
        return `- only - testing: ${e} `;
    }).join(" ");
    await commandContext.execShell(
        "Run Tests For Current File",
        { file: "test_app.sh" },
        [sessionID, isDebuggable ? "DEBUG_LLDB" : "RUNNING", "-SELECTED", option],
    );
}

export async function enableXCBBuildService(enabled: boolean) {
    await sleep(5000);
    const checkIfInjectedCommand = `python3 ${getScriptPath("xcode_service_setup.py")} - isProxyInjected`;

    return new Promise<void>((resolve) => {
        exec(checkIfInjectedCommand, async (error, stdout, stderr) => {
            if (enabled && error === null || !enabled && error != null) {
                resolve();
                return;
            }
            const isInstallStr = enabled ? "INSTALL" : "DISABLED";
            const password = await vscode.window.showInputBox({ ignoreFocusOut: false, prompt: `In order to ${isInstallStr} XCBBuildService, please enter sudo password`, password: true });
            if (password === undefined) {
                resolve();
                return;
            }
            const install = enabled ? "-install" : "-uninstall"
            const command = `echo '${password}' | sudo - S python3 ${getScriptPath("xcode_service_setup.py")} ${install} ${getXCBBuildServicePath()} `;
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    if (enabled)
                        vscode.window.showErrorMessage(`Failed to install XCBBuildService`);
                    else
                        vscode.window.showErrorMessage(`Failed to uninstall XCBBuildService`);
                } else {
                    if (enabled)
                        vscode.window.showInformationMessage("XCBBuildService proxy setup successfully");
                    else
                        vscode.window.showInformationMessage("XCBBuildService Proxy was uninstall successfully")
                }
                resolve();
            });
        });
    });
}

export async function openFile(filePath: string, lineNumber: number, viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active) {
    const fileUri = vscode.Uri.file(path.resolve(filePath));
    const document = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(document, viewColumn, false);
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
    await vscode.commands.executeCommand("cursorMove", {
        to: "down",
        select: false,
        by: "line",
        value: lineNumber
    });
}

// diff
export async function ksdiff(name: string, path1: string, path2: string) {
    const filePrefix = "file://";
    if (path1.startsWith(filePrefix))
        path1 = path1.slice(filePrefix.length);
    if (path2.startsWith(filePrefix))
        path2 = path2.slice(filePrefix.length);
    vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(path1), vscode.Uri.file(path2), name);
}