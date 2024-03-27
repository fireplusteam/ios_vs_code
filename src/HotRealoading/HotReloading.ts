import fs from "fs"
import * as vscode from "vscode";
import { preCalcLineNumbers } from "../TestsProvider/parseMarkdown";

export async function modifiedContent(uri: vscode.Uri, text: string) {
    const preCalcLines = preCalcLineNumbers(text);
    let ms = [...text.matchAll(/((struct|class).*?)(\S)[\s\S]*?({)/gm)];
    let files = new Set<string>();
    for (let m of ms) {
        const index = m.index || 0;
        let offset = index;
        for (; offset >= 0; --offset)
            if (text[offset] === "\n") break;
        offset += 1;

        const refs = await getRelatedFiles(uri, new vscode.Position(preCalcLines[index + m[1].length], index - offset + m[1].length));
        refs.forEach(e => {
            files.add(e.fsPath);
        });
    }

    fs.writeFileSync(uri.fsPath, text);
    for (const file of files) {
        if (file !== uri.fsPath)
            fs.appendFileSync(file, ' ');
    }
}

async function getRelatedFiles(uri: vscode.Uri, pos: vscode.Position) {
    const references: vscode.Location[] = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, pos);
    return references.map(e => {
        return e.uri;
    })
}
