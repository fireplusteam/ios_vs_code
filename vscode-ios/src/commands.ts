import * as vscode from "vscode";
import { Executor, ExecutorReturnType } from "./execShell";
import { showPicker } from "./inputPicker";
import { getEnvList } from "./env";
import { buildSelectedTarget } from "./build";

export async function selectTarget(executor: Executor) {
  if ((await checkWorkspace(executor)) === false) {
    return false;
  }
  let stdout = (await executor.execShell(
    "Fetch Project Targets",
    "populate_schemes.sh",
    [],
    false,
    ExecutorReturnType.stdout
  )) as string;

  stdout = stdout.trim();
  const lines = stdout.split("\n");

  let option = await showPicker(lines[lines.length - 1],
    "Target",
    "Please select Target",
    false,
  );

  if (option === undefined) {
    return false;
  }

  return await executor.execShell(
    "Update Selected Target",
    "update_enviroment.sh",
    ["-destinationScheme", option]
  );
}

export async function selectDevice(executor: Executor, shouldCheckWorkspace = true) {
  if (shouldCheckWorkspace === true && (await checkWorkspace(executor)) === false) {
    return false;
  }
  let stdout = (await executor.execShell(
    "Fetch Devices",
    "populate_devices.sh",
    ["-single"],
    false,
    ExecutorReturnType.stdout
  )) as string;

  stdout = stdout.trim();
  const lines = stdout.split("\n");
  let option = await showPicker(
    lines[lines.length - 1],
    "Device",
    "Please select Device for DEBUG",
    false
  );

  if (option === undefined) {
    return false;
  }

  return await executor.execShell(
    "Update DEBUG Device",
    "update_enviroment.sh",
    ["-destinationDevice", option]
  );
}

export async function checkWorkspace(executor: Executor) {
  if (await executor.execShell("Validate Environment", "check_workspace.sh") === false) {
    return false;
  }
  const env = getEnvList();
  if (!env.hasOwnProperty("DEVICE_ID")) {
    return selectDevice(executor, false);
  }
}

export async function generateXcodeServer(executor: Executor) {
  if ((await checkWorkspace(executor)) === false) {
    return false;
  }
  return await executor.execShell(
    "Generate xCode Server",
    "build_autocomplete.sh"
  );
}

export async function runApp(executor: Executor) {
  if ((await buildSelectedTarget(executor)) === false) {
    return false;
  }
  return await executor.execShell(
    "Run App",
    "run_app.sh",
    ["LLDB_DEBUG"],
    false
  );
}
