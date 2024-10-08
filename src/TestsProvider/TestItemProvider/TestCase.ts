import { TestStyle } from "../../LSP/lspExtension";
import { CustomError } from "../../utils";

const InvalidTestCase = new CustomError("Invalid Test Case");

export class TestCase {
    constructor(
        private readonly testName: string | undefined,
        private readonly suite: string | undefined,
        private readonly target: string | undefined,
        private readonly testStyle: TestStyle
    ) {}

    getLabel() {
        return this.testName as string;
    }

    getXCodeBuildTest() {
        if (this.target && this.testName) {
            const list = [this.target];

            if (this.suite !== undefined && this.suite.length > 0) {
                list.push(this.suite);
            }

            // TODO: remove this once xcodebuild tool supports full test id path
            // for some reason for new swift testing framework it doesn't understand the last part of the path
            if (this.testStyle === "swift-testing") {
                const testName = this.testName.split("/").slice(0, -1).join("/");
                if (testName !== undefined && testName.length > 0) {
                    list.push(testName);
                }
            } else {
                list.push(this.testName);
            }

            return list.join("/");
        }
        throw InvalidTestCase;
    }

    getTestId() {
        if (this.target && this.testName) {
            if (this.suite) {
                return `${this.target}/${this.suite}/${this.testName}`;
            } else {
                return `${this.target}/${this.testName}`;
            }
        }
        throw InvalidTestCase;
    }
}
