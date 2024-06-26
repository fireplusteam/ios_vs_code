import subprocess
import json
import os
import time
import sys

#-----------------------ARGS

def get_arg_value_by_name(name: str):
    for i, arg in enumerate(sys.argv):
        if arg == name:
            return sys.argv[i + 1]


#-----------------------FILE_LOCK
file_path = '.vscode/.env'

class FileLock:
    def __init__(self, file_name):
        self.lock_file = f"{file_name}.lock"

    def __enter__(self):
        while True:
            try:
                # If the lock file can be created, it means there's no other one existing
                self.fd = os.open(self.lock_file, os.O_CREAT | os.O_EXCL | os.O_RDWR)
                break;
            except FileExistsError:
                # If the creation fails because the file already exists the file is locked by another process
                time.sleep(0.1)

    def __exit__(self, exc_type, exc_val, exc_tb):
        os.close(self.fd)
        os.remove(self.lock_file)


def get_env_list():
    dict = {}
    with FileLock(file_path + '.lock'):
        with open(file_path, 'r') as file:
            for line in file:
                pos = line.strip().find("=")
                dict[line.strip()[:pos]] = line.strip()[pos + 1:]
    return dict


def safe_env_list(list):
    with FileLock(file_path + '.lock'):
        with open(file_path, 'w') as file:
            for key, value in list.items():
                file.write(key + "=" + value + "\n")


def get_project_type(project_file):
    if ".xcodeproj" in project_file:
        return "-project"
    if "Package.swift" in project_file:
        return "-package"
    return "-workspace"


def get_schemes(project_file, is_build_configuration = False):
    command = ["xcodebuild", "-list"]
    scheme_type = get_project_type(project_file)
    if "-package" != scheme_type:
        command.extend([get_project_type(project_file), project_file])
    elif is_build_configuration:
        return ["Debug", "Release"]
    process = subprocess.run(command, capture_output=True, text=True)
    schemes = []
    is_tail = False
    for x in process.stdout.splitlines():
        if len(x.strip()) == 0 and is_tail:
            break
        if is_tail and len(x) > 0:
            schemes.append(x.strip())
        if not is_build_configuration:
            if "Schemes:" in x:
                is_tail = True
        else:
            if "Build Configurations:" in x:
                is_tail = True
    
    if len(schemes) == 0:
        print(f"Error: {process.stdout}")
    
    return schemes


def get_project_settings(project_file, scheme, build_configuration = None):
    list = get_env_list()
    if build_configuration is None:
        build_configuration = list["PROJECT_CONFIGURATION"].strip("\"")
    command = ["xcodebuild", "-showBuildSettings", get_project_type(project_file), project_file, "-scheme", scheme, "-configuration", build_configuration ]
    process = subprocess.run(command, capture_output=True, text=True)
    return process.stdout


def get_bundle_identifier(project_file, scheme, build_configuration = None):
    stdout = get_project_settings(project_file, scheme, build_configuration)
    for line in stdout.splitlines():
        line = line.strip()
        if "BUNDLE_IDENTIFIER" in line:
            return line.split("=")[1].strip()
    
    return None


def get_product_name_imp(project_file, scheme):
    stdout = get_project_settings(project_file, scheme)
    #print("Out: " + stdout)
    for line in stdout.splitlines():
        line = line.strip()
        if "PRODUCT_NAME" in line:
            return line.split("=")[1].strip()
    
    return None


def update_scheme(project_file, scheme):
    env_list = get_env_list()
    env_list["PROJECT_SCHEME"] = "\"" + scheme + "\""
    identifier = get_bundle_identifier(project_file, scheme)
    if identifier is None:
        identifier = ""
    env_list["BUNDLE_APP_NAME"] = "\"" + identifier + "\""
    safe_env_list(env_list)


def update_configuration(project_file, configuration):
    env_list = get_env_list()
    env_list["PROJECT_CONFIGURATION"] = "\"" + configuration + "\""
    if "PROJECT_SCHEME" in env_list:
        identifier = get_bundle_identifier(project_file, env_list["PROJECT_SCHEME"].strip("\""), configuration)
        if identifier is None:
            identifier = ""
        env_list["BUNDLE_APP_NAME"] = "\"" + identifier + "\""  
    safe_env_list(env_list)


def get_target_executable_impl(build_path, product_name):
   build_configuration = get_env_list()["PROJECT_CONFIGURATION"].strip("\"")
   return f"{build_path}/Build/Products/{build_configuration}-iphonesimulator/{product_name}.app"


def get_project_config():
    file_path = 'buildServer.json'
    with open(file_path, 'r') as file:
       config = json.load(file)
    return config


def get_derived_data_path():
    config = get_project_config()
    return config["build_root"]


def get_target_executable():
    list = get_env_list()
    if get_project_type(list["PROJECT_FILE"]) == "-package":
        return "/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneSimulator.platform/Developer/Library/Xcode/Agents/xctest"
    product_name = get_product_name() 
    config = get_project_config()
    build_root = config["build_root"]
    return get_target_executable_impl(build_path=build_root, product_name=product_name)


def get_product_name():
    list = get_env_list()
    if get_project_type(list["PROJECT_FILE"]) == "-package":
        return "xctest"
    
    config = get_project_config()
    scheme = config["scheme"]
    return get_product_name_imp(list["PROJECT_FILE"].strip("\""), scheme).removesuffix(".app")


def update_project_file(project_file):
    env_list = get_env_list()
    env_list["PROJECT_FILE"] = "\"" + project_file + "\""
    safe_env_list(env_list)
    # update schemes
    schemes = get_schemes(project_file)
    update_scheme(project_file, schemes[0])


def is_build_server_valid():
    env_list = get_env_list()
    json_file_path = "buildServer.json"
    if not os.path.exists(json_file_path):
        return False

    with open(json_file_path, 'r') as file:
        build_server = json.load(file)
    
    print("BuildServer: ", build_server, "\nENV_FILE:", env_list)

    if not (env_list["PROJECT_FILE"].strip("\"") in build_server["workspace"]):
        return False

    if build_server["scheme"] != env_list["PROJECT_SCHEME"].strip("\""):
        return False

    # path to xcode-build-server
    lsp_argv = build_server["argv"]
    is_valid_server_path = False
    for arg in lsp_argv:
        if os.getenv("VS_IOS_XCODE_BUILD_SERVER_PATH") in arg:
            is_valid_server_path = True
    if not is_valid_server_path:
        return False;

    return True

# --------GIT-------------------------------------

def update_git_exclude(file_to_exclude):
    if not os.path.exists(".git"):
        return
    os.makedirs(".git/info", exist_ok=True)
    content = None
    try:
        with open(".git/info/exclude", 'r') as file:
            content = file.readlines()
    except: pass
    #print(f"Updating git ignore: {content}")
    if content is None:
        content = []
    if len([x for x in content if f"{file_to_exclude}".strip() == x.strip()]) == 0:
        content.insert(0, f"{file_to_exclude}\n")
        #print(f"CHANGED: {content}")
        try:
            with open(".git/info/exclude", "w+") as file:
                file.write(''.join(content))   
        except Exception as e:
            print(f"Git ignore update exception: {str(e)}")


#---------DEBUGGER--------------------------------
debugger_config_file = ".logs/debugger.launching"
def wait_debugger_to_launch(session_id):
    while True:
        with FileLock(debugger_config_file + '.lock'):
            with open(debugger_config_file, 'r') as file:
                config = json.load(file)
        if config is not None and not session_id in config:
            break
            
        if config is not None and config[session_id]["status"] == "launched":
            break

        time.sleep(1)

def is_debug_session_valid(session_id, start_time) -> bool:
    try:
        with FileLock(debugger_config_file + '.lock'):
            with open(debugger_config_file, 'r') as file:
                config = json.load(file)
        if not session_id in config:
            return False
        if config[session_id]["sessionEndTime"] >= start_time:
            return False
        return True
    except: # no file or a key, so the session is valid
        return True
    
def update_debug_session_time(session_id: str):
    update_debugger_launch_config(session_id, "sessionEndTime", time.time())

def update_debugger_launch_config(session_id, key, value):
    config = {}
    if os.path.exists(debugger_config_file):
        with FileLock(debugger_config_file + '.lock'):
            with open(debugger_config_file, "r+") as file:
                config = json.load(file)
    
    if session_id in config:
        config[session_id][key] = value;
    else:
        config[session_id] = {}
        config[session_id][key] = value
    
    with FileLock(debugger_config_file + '.lock'):
        with open(debugger_config_file, "w+") as file:
            json.dump(config, file, indent=2)

if __name__ == "__main__":
    print("ok")