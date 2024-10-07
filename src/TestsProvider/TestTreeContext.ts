import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import { TestContainer } from './TestItemProvider/TestContainer';
import { TestCase } from './TestItemProvider/TestCase';
import { TestHeading } from './TestItemProvider/TestHeading';
import { CoverageProvider } from './CoverageProvider';
import { LSPTestsProvider } from '../LSP/LSPTestsProvider';

const textDecoder = new TextDecoder('utf-8');

export type MarkdownTestData = TestHeading | TestCase | TestContainer;

export class TestTreeContext {
    testData = new WeakMap<vscode.TestItem, MarkdownTestData>();
    ctrl: vscode.TestController = vscode.tests.createTestController('iOSTestController', 'iOS Tests');
    coverage: CoverageProvider = new CoverageProvider(".vscode/.bundle.xcresult");
    lspTestProvider: LSPTestsProvider;

    constructor(lspTestProvider: LSPTestsProvider) {
        this.lspTestProvider = lspTestProvider;
    }

    static TestID(id: string, uri: vscode.Uri) {
        return `${id}/${uri.toString()}`;
    }

    getOrCreateTest(
        id: string,
        uri: vscode.Uri,
        provider: () => any
    ) {
        const uniqueId = TestTreeContext.TestID(id, uri);
        const existing = this.get(uniqueId, this.ctrl.items);
        if (existing) {
            return { file: existing, data: this.testData.get(existing) };
        }

        const file = this.ctrl.createTestItem(uniqueId, uri.path.split('/').pop()!, uri);
        this.ctrl.items.add(file);

        const data = provider();
        this.testData.set(file, data);

        file.canResolveChildren = true;
        return { file, data };
    }

    private get(key: string, items: vscode.TestItemCollection) {
        for (const [id, item] of items) {
            if (id == key) {
                return item;
            }
            const value = this.getImp(key, item);
            if (value !== undefined) {
                return value;
            }
        }
    }

    private getImp(key: string, item: vscode.TestItem): vscode.TestItem | undefined {
        if (item.id === key)
            return item;

        for (const [id, child] of item.children) {
            const value = this.getImp(key, child);
            if (value !== undefined) {
                return value;
            }
        }
        return undefined;
    }

    addItem(item: vscode.TestItem, shouldAdd: (root: vscode.TestItem) => boolean) {
        let res = false;
        this.ctrl.items.forEach(childItem => {
            if (res) return;
            res = res || this.addItemImp(item, childItem, shouldAdd);
        })
        return res;
    }

    private addItemImp(item: vscode.TestItem, root: vscode.TestItem, shouldAdd: (root: vscode.TestItem) => boolean) {
        if (shouldAdd(root)) {
            // found
            root.children.add(item);
            return true;
        } else {
            let res = false;
            root.children.forEach(childItem => {
                if (res) return;
                res = this.addItemImp(item, childItem, shouldAdd);
            });
            return res;
        }
    }

    deleteItem(id: string | vscode.TestItem) {
        let tree: vscode.TestItem | undefined;
        if (typeof id == "string") {
            tree = this.get(id, this.ctrl.items);
        } else {
            tree = id;
        }
        if (tree) {
            this.testData.delete(tree);
            if (tree.parent)
                tree.parent.children.delete(tree.id);
            else
                this.ctrl.items.delete(tree.id);
        }
    }

    public replaceItemsChildren(item: vscode.TestItem, itemsChildren: vscode.TestItem[]) {
        const childs: vscode.TestItem[] = [];
        for (const child of item.children) {
            childs.push(child[1]);
        }
        for (const child of childs) {
            this.deleteItem(child);
        }
        item.children.replace(itemsChildren);
    }

    allTestItems() {
        const list = [] as vscode.TestItem[];
        this.ctrl.items.forEach(item => {
            this.allTestItemsImp(list, item);
        });
        return list;
    }

    private allTestItemsImp(list: vscode.TestItem[], root: vscode.TestItem) {
        list.push(root);
        root.children.forEach(item => {
            this.allTestItemsImp(list, item);
        })
    }
}

export const getContentFromFilesystem = async (uri: vscode.Uri) => {
    try {
        const rawContent = await vscode.workspace.fs.readFile(uri);
        return textDecoder.decode(rawContent);
    } catch (e) {
        console.warn(`Error providing tests for ${uri.fsPath}`, e);
        return '';
    }
};