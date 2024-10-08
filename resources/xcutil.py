#!/usr/bin/env python3
import subprocess
import json
import xml.etree.ElementTree as ET
import os
import sys
import hashlib
import helper

from pprint import pprint

class XCProjectUtil:

    def __init__(self, project_file):
        project_file += "/project.pbxproj"

        result_path = ".vscode/project.json"
        process = subprocess.run(["plutil", "-convert", "json", "-o", result_path, project_file], capture_output=True)
        if process.returncode != 0:
            print(process.stdout)        
            print(f"Error converting {project_file} to json")
            raise Exception(f"Error converting {project_file} to json")

        with open(result_path, "r") as file:
            config = json.load(file)

        self.objects = config["objects"]
        self.rootObject = config["rootObject"]
        
    def object(self, id):
        if self.is_object(id):
            return self.objects[id]
        return id
    
    def is_object(self, id):
        if isinstance(id, str):
            return id in self.objects
        return False

    def resolveObject(self, object):
        if isinstance(object, list):
            res = []
            for child in object:
                res.append(self.resolveObject(child))
            return res
        elif isinstance(object, dict):
            res = {}
            for key, child in object.items():
                res[key] = self.resolveObject(child)
            return res
        elif isinstance(object, str):
            return self.object(object)


class XCProjectPath:

    def __init__(self, util: XCProjectUtil, root = None):
        self.util = util
        if root is not None:
            self._root = root
        else:
            self._root = util.rootObject
        
        self._index = 0
        self._object = util.resolveObject(self._root)
        self.value = self._object

    def __getitem__(self, key):
        return XCProjectPath(self.util, root=self._object[key])
    
    def __iter__(self):
        iter = XCProjectPath(util=self.util, root=self._root)
        return iter
    
    def __next__(self):
        if self._index < len(self._object):
            result = self._object[self._index]
            self._index += 1
            return XCProjectPath(self.util, result)
        else:
            raise StopIteration


class XCWorkspaceUtil:

    def __init__(self, file_path):
        self._path = file_path        

    def project_files(self):
        file_path = self._path
        project_files = []
        if ".xcworkspace" in file_path:
            file_path += "/contents.xcworkspacedata"
            tree = ET.parse(file_path)
            root = tree.getroot()
        
            for ref in root.findall("FileRef"):
                location = ref.attrib['location']
                location = location.removeprefix("group:")
                if ".xcodeproj" in location:
                    project_files.append(location)
        elif ".xcodeproj" in file_path:
            project_files.append(file_path)
        
        return project_files


def get_files_for_project(project_file):
    project_files = XCWorkspaceUtil(project_file).project_files()
    print(f"Found project files: {project_files}")

    config = {}
    for project in project_files:
        project_util = XCProjectUtil(project)
        xc_path = XCProjectPath(project_util)
        
        for target in xc_path["targets"]:
            name = target["name"]
            
            all_files = []
            build_phases = target["buildPhases"]
            for build_phase in build_phases:
                files = build_phase["files"]
                for file in files:
                    file_ref = file["fileRef"]
                    try: 
                        path = file_ref["path"]
                        all_files.append(path.value)
                    except KeyError:
                        childrens = file_ref["children"]
                        for children in childrens:
                            path = children["path"]
                            all_files.append(path.value)

            config[name.value] = all_files

    return config

def get_scheme_by_file_name(project_file, file: str):
    if helper.get_project_type(project_file) == "-package":
        scheme = None
        path = file
        while True:
            path, folder = os.path.split(path)
            if folder == "Sources":
                return scheme
            elif folder == "Tests":
                return scheme
            elif folder == "" or path == "":
                return None
            scheme = folder
                
         
    config = get_files_for_project(project_file)
    file = os.path.basename(file)

    #pprint(config)
    
    for scheme, files in config.items():
        if file in files:
            return scheme
    return None

# PARSE

token = set()

def find_key(project_file, md5_pattern):
    
    def check(value_to_check):
        md5 = hashlib.md5((value_to_check).encode()).hexdigest()
        if md5 == md5_pattern:
            raise Exception(value_to_check)
        else:
            token.add(value_to_check)
            
    def rec_check(u):
        if isinstance(u, list):
            for x in u:
                rec_check(x)
        if isinstance(u, dict):
            for key, value in u.items():
                check(key)
                rec_check(u[key])
        if isinstance(u, str):
            check(u)
    
    project_files = XCWorkspaceUtil(project_file).project_files()
    
    for project in project_files:
        project_util = XCProjectUtil(project)
        rec_check(project_util.rootObject)
        for key, obj in project_util.objects.items():
            rec_check(key)
            rec_check(obj)
                        

if __name__ == "__main__":
    #project_file = os.getenv("PROJECT_FILE")

    project_file = sys.argv[1]
    selected_file = sys.argv[2]

    print(get_scheme_by_file_name(project_file, selected_file))
#plutil -convert json -o project.json TestVSCode/TestVSCode.xcodeproj/project.pbxproj

#TestVSCodeTests/TestVSCodeTests/testExample3


