#!/bin/bash
source '.vscode/.env'

if [ "$2" == "CANCEL" ]; then
    echo "TESTS RUNNING WAS CANCELED"
    exit 0
fi

source "$VS_IOS_SCRIPT_PATH/xcode_build_util.sh"

XCODECMD="xcodebuild test-without-building -parallel-testing-enabled NO -scheme \"$PROJECT_SCHEME\" $XCODECMD"
echo "Base XCODECMD: $XCODECMD"

export NSUnbufferedIO=YES
export XCT_PARALLEL_DEVICE_DESTINATIONS=1

rm -r .vscode/.bundle.xcresult
rm -r .vscode/.bundle

VALID_TESTS=1

# uncomment below if you want to reset all cache on simulators

#echo "Shutting down the simulator app"
#osascript -e 'quit app "Simulator"'
#
#echo "Making sure ALL simulators are shutdown"
#xcrun simctl list | grep Booted | grep -e "[0-9A-F\-]\{36\}" -o | xargs xcrun simctl shutdown
#
#echo "Erasing apps from all simulators and resetting back to clean state"
#xcrun simctl erase all
#
#echo "Killing com.apple.CoreSimulator.CoreSimulatorService"
#killall -9 com.apple.CoreSimulator.CoreSimulatorService

echo "DEBUGGER_ARG: $2"

echo "WAITING FOR DEBUGGER"
python3 <<EOF
import sys
sys.path.insert(0, "$VS_IOS_SCRIPT_PATH")
import helper
helper.wait_debugger_to_launch("$1")
EOF

check_exit_status() {
    local exit_status="$1"
    if [ "${exit_status}" -ne 0 ]; then
        echo "Test Failed.■" >>.logs/tests.log
        exit 1
    fi
}

if [ "$3" == "-ALL" ]; then
    set -o pipefail
    eval "$XCODECMD | tee '.logs/tests.log' | tee '.logs/app_$DEVICE_ID.log' | xcbeautify"
    check_exit_status "${PIPESTATUS[0]}"
else
    echo "Input: '$*'"

    # get last line of output
    TESTS="$4"

    if [ "$TESTS" == "Not_defined" ]; then
        echo "Tests are not defined for the given file"
        VALID_TESTS=0
    else
        echo "Running tests: $TESTS"

        echo "$XCODECMD $TESTS"
        set -o pipefail
        eval "$XCODECMD $TESTS | tee '.logs/tests.log' | tee '.logs/app_$DEVICE_ID.log' | xcbeautify"
        check_exit_status "${PIPESTATUS[0]}"
    fi
fi

echo "Test Finished.■" >>.logs/tests.log
