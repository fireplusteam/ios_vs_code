import * as vscode from 'vscode';
import { Executor, ExecutorMode, ExecutorReturnType } from "./execShell";
import { showPicker } from "./inputPicker";
import { getDeviceId, getEnvList, getProjectPath, getProjectScheme, getScriptPath, getWorkspacePath, getXCBBuildServicePath, updateProject } from "./env";
import { buildSelectedTarget } from "./buildCommands";
import { emptyAppLog, getLastLine, killSpawnLaunchedProcesses } from "./utils";
import * as path from 'path';
import { ProblemDiagnosticResolver } from './ProblemDiagnosticResolver';
import { exec } from 'child_process';
import { ProjectManager } from './ProjectManager/ProjectManager';
import { glob } from 'glob';

export async function selectProjectFile(executor: Executor, projectManager: ProjectManager, showProposalMessage = false, ignoreFocusOut = false) {
    const workspaceEnd = ".xcworkspace/contents.xcworkspacedata";
    const projectEnd = ".xcodeproj/project.pbxproj";
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
    updateProject(selection);
    await projectManager.loadProjectFiles(true);
    await selectTarget(executor, true, false);
    return true;
}

export async function selectTarget(executor: Executor, ignoreFocusOut = false, shouldCheckWorkspace = true) {
    if (shouldCheckWorkspace) {
        await checkWorkspace(executor, ignoreFocusOut);
    }

    let stdout = getLastLine((await executor.execShell(
        "Fetch Project Targets",
        "populate_schemes.sh",
        [],
        false,
        ExecutorReturnType.stdout
    )) as string);

    let option = await showPicker(stdout,
        "Target",
        "Please select Target",
        false,
        ignoreFocusOut,
        true
    );

    if (option === undefined) {
        return;
    }

    await executor.execShell(
        "Update Selected Target",
        "update_environment.sh",
        ["-destinationScheme", option]
    );

    await checkWorkspace(executor);
}

export async function selectDevice(executor: Executor, shouldCheckWorkspace = true, ignoreFocusOut = false) {
    if (shouldCheckWorkspace === true) {
        await checkWorkspace(executor);
    }
    let stdout = getLastLine((await executor.execShell(
        "Fetch Devices",
        "populate_devices.sh",
        ["-single"],
        false,
        ExecutorReturnType.stdout,
    )) as string);

    let option = await showPicker(
        stdout,
        "Device",
        "Please select Device for DEBUG",
        false,
        ignoreFocusOut,
        true
    );

    if (option === undefined) {
        return false;
    }

    return await executor.execShell(
        "Update DEBUG Device",
        "update_environment.sh",
        ["-destinationDevice", option]
    );
}

export async function restartLSP() {
    await vscode.commands.executeCommand("swift.restartLSPServer");
}

export async function checkWorkspace(executor: Executor, ignoreFocusOut = false) {
    try {
        if (getProjectScheme().length == 0) {
            await selectTarget(executor, true, false);
        }
    } catch {
        await selectTarget(executor, true, false);
    }
    const command = getLastLine(await executor.execShell(
        "Validate Environment",
        "check_workspace.sh",
        [],
        false,
        ExecutorReturnType.stdout
    ) as string);
    if (command === "Restarting LSP") {
        restartLSP();
    }
    const env = getEnvList();
    if (!env.hasOwnProperty("DEVICE_ID")) {
        await selectDevice(executor, false, ignoreFocusOut);
    }
}

export async function generateXcodeServer(executor: Executor) {
    await checkWorkspace(executor);
    await executor.execShell(
        "Generate xCode Server",
        "build_autocomplete.sh"
    );
}

export async function openXCode() {
    exec(`open '${getProjectPath()}'`);
}

export async function terminateCurrentIOSApp(sessionID: string, executor: Executor, silent = false) {
    await executor.execShell(
        "Terminate Current iOS App",
        "terminate_current_running_app.sh",
        [sessionID],
        false,
        ExecutorReturnType.statusCode,
        silent ? ExecutorMode.silently : ExecutorMode.verbose
    );
    await killSpawnLaunchedProcesses(sessionID);
}

export async function runApp(sessionID: string, executor: Executor, isDebuggable: boolean) {
    emptyAppLog(getDeviceId());
    await executor.execShell(
        "Run App",
        "run_app.sh",
        [sessionID, isDebuggable ? "LLDB_DEBUG" : "RUNNING"],
        false
    );
}

export async function runAppOnMultipleDevices(sessionID: string, executor: Executor, problemResolver: ProblemDiagnosticResolver) {
    let stdout = getLastLine((await executor.execShell(
        "Fetch Multiple Devices",
        "populate_devices.sh",
        ["-multi"],
        false,
        ExecutorReturnType.stdout
    )) as string);

    let option = await showPicker(
        stdout,
        "Devices",
        "Please select Multiple Devices to Run You App",
        true,
        false,
        true
    );

    if (option === undefined || option === '') {
        return;
    }

    await buildSelectedTarget(executor, problemResolver);
    await terminateCurrentIOSApp(sessionID, executor);

    for (let device of option.split(" ")) {
        emptyAppLog(device.substring("id=".length));
    }
    await executor.execShell(
        "Run App On Multiple Devices",
        "run_app.sh",
        [sessionID, "RUNNING", "-DEVICES", `${option}`],
        false
    );
}

export async function runAndDebugTests(sessionID: string, executor: Executor, isDebuggable: boolean) {
    await executor.execShell(
        "Run Tests",
        "test_app.sh",
        [sessionID, isDebuggable ? "DEBUG_LLDB" : "RUNNING", "-ALL"],
        false
    );
}

export async function runAndDebugTestsForCurrentFile(sessionID: string, executor: Executor, isDebuggable: boolean, tests: string[]) {
    const option = tests.map(e => {
        return `-only-testing:${e}`;
    }).join(" ");
    await executor.execShell(
        "Run Tests For Current File",
        "test_app.sh",
        [sessionID, isDebuggable ? "DEBUG_LLDB" : "RUNNING", "-SELECTED", option],
        false
    );
}

export async function enableXCBBuildService(enabled: boolean) {
    const install = enabled ? "-install" : "-uninstall"
    const command = `python3 ${getScriptPath("xcode_service_setup.py")} ${install} ${getXCBBuildServicePath()}`;
    exec(command, (error, stdout, stderr) => {
        console.log(error);
    });
}

export async function openFile(filePath: string, lineNumber: number) {
    const fileUri = vscode.Uri.file(path.resolve(filePath));
    const document = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Active, false);
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