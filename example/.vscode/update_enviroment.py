import sys
import helper
import populate_tests_of_current_file
import json

project_file = sys.argv[1]
type = sys.argv[2]

env_list = helper.get_env_list()

print(env_list)


def label_value(value):
    picked_prefix = "$(notebook-state-success) "
    if value.startswith(picked_prefix):
        value = value[len(picked_prefix):]
    return value


if type == "-multipleDestinationDevices":
    print("update multiple destination device")
    
    devices = sys.argv[3]
    print(f"New Multiple Devices are: {devices}")
    key = "MULTIPLE_DEVICE_ID"
    env_list[key] = "\"" + devices + "\""
    helper.safe_env_list(env_list) 

elif type == "-destinationDevice":
    print("update destination device")

    device = label_value(sys.argv[3])
    
    cache_file = ".cache/populated_devices.json"
    with helper.FileLock(cache_file + '.lock'):
        with open(cache_file, "r") as file:
            config = json.load(file)
    
    for device_config in config:
        label = label_value(device_config["label"])
        if label == device:
            device = device_config["value"]

    print(f"new selected device: {device}")
    
    key, value = device.split('=')
    if key == "id":
        key = "DEVICE_ID"
    else:
        assert(False) 

    env_list[key] = "\"" + value + "\""
    
    helper.safe_env_list(env_list)
elif type == "-destinationScheme":
    scheme = label_value(sys.argv[3])
    print("Selected Target: " + scheme)
    helper.update_scheme(project_file, scheme)

elif type == "-destinationTests":
    error_message = "Not_defined"
    result = error_message
    try:
        tests = sys.argv[4]
        
        if tests == "CURRENTLY_SELECTED":
            tests = populate_tests_of_current_file.get_last_selected_tests()
        else:
            tests = tests.split()
        
        print("Tests: " + str(tests))

        populate_tests_of_current_file.store_selected_tests(tests)
        
        result = ""
        for test in tests:
            result += f"-only-testing:{test}"
            if test != test[-1]:
                result += " "
    except Exception as e:
        print(str(e))

        result = error_message
    finally:
        print(result)