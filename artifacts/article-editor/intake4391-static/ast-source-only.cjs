const fs = require('node:fs');
const path = require('node:path');
const ts = require('/workspace/FsusBlog/src/frontend/node_modules/typescript');
for (const root of ['/workspace/FsusBlog-intake4391-base', '/workspace/FsusBlog-intake4391']) {
    const file = path.join(root, 'src/frontend/src/composables/article/useCodeBlockCopy.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (source.parseDiagnostics.length) {
        for (const error of source.parseDiagnostics) console.error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
        process.exitCode = 1;
    }
    console.log(JSON.stringify({ file, parser: ts.version, parseDiagnostics: source.parseDiagnostics.length, productEvaluation: false }));
}
