import * as vscode from "vscode";
import * as fs from "fs";
import { TestTreeContext } from "../TestTreeContext";
import { TestContainer } from "./TestContainer";
import { getFilePathInWorkspace } from "../../env";
import { FSWatcher, watch } from "fs";
import path from "path";
import { TestTarget } from "./TestTarget";

export class TestProject implements TestContainer {
    public didResolve = false;

    public context: TestTreeContext;

    public targetProvider: () => Promise<string[]>;
    public filesForTargetProvider: (target: string) => Promise<string[]>;

    private fsWatcher: FSWatcher | undefined;
    private projectContent: Buffer | undefined;

    constructor(
        context: TestTreeContext,
        targetProvider: () => Promise<string[]>,
        filesForTargetProvider: (target: string) => Promise<string[]>
    ) {
        this.context = context;
        this.targetProvider = targetProvider;
        this.filesForTargetProvider = filesForTargetProvider;
    }

    public async updateFromDisk(controller: vscode.TestController, item: vscode.TestItem) {
        try {
            await this.updateFromContents(controller, "", item);
        } catch (e) {
            item.error = (e as Error).stack;
        }
    }

    public async updateFromContents(
        controller: vscode.TestController,
        content: string,
        item: vscode.TestItem
    ) {
        const parent = { item, children: [] as vscode.TestItem[] };
        const targets = await this.targetProvider();
        const weakRef = new WeakRef(this);

        for (const target of targets) {
            const url = TestTreeContext.getTargetFilePath(item.uri, target);
            const { file, data } = this.context.getOrCreateTest("target://", url, () => {
                return new TestTarget(this.context, async () => {
                    return (await weakRef.deref()?.filesForTargetProvider(target)) || [];
                });
            });

            if (!data.didResolve) {
                await data.updateFromDisk(controller, file);
            }
            if ([...file.children].length > 0) {
                parent.children.push(file);
            } else {
                this.context.deleteItem(file.id);
            }
        }

        // watch to changes for a file, if it's changed, refresh unit tests
        const filePath = getFilePathInWorkspace(
            path.join(item.uri?.path || "", item.label === "Package.swift" ? "" : "project.pbxproj")
        );
        this.watchFile(filePath, controller, item);

        this.didResolve = true;
        // finish

        this.context.replaceItemsChildren(item, parent.children);
    }

    private watchFile(
        filePath: string,
        controller: vscode.TestController,
        item: vscode.TestItem,
        contentFile: Buffer | undefined = undefined
    ) {
        const weakRef = new WeakRef(this);

        this.fsWatcher?.close();
        this.fsWatcher = undefined;
        this.fsWatcher = watch(filePath);
        this.fsWatcher.on("change", () => {
            const content = fs.readFileSync(filePath);
            if (this.projectContent?.toString() === content.toString()) {
                this.watchFile(filePath, controller, item, content);
                return;
            }
            this.projectContent = content;
            setTimeout(() => {
                weakRef.deref()?.context.replaceItemsChildren(item, []);
                weakRef.deref()?.updateFromDisk(controller, item);
            }, 1000);
        });
        if (contentFile === undefined) {
            this.projectContent = fs.readFileSync(filePath);
        } else {
            this.projectContent = contentFile;
        }
    }
}
