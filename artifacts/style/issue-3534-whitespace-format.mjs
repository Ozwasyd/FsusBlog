// Task-scoped mechanical migration procedure; does not define style policy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { javascriptFormatFingerprint } from '../../tools/governance/javascript-format-equivalence.mjs';

const { ESLint } = await import(new URL('../../tools/frontend/style-toolchain/node_modules/eslint/lib/api.js', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const paths = [
    'tools/docs/behavior-document-consistency-final.mjs',
    'tests/tools/behavior-document-consistency-final.test.mjs'
];
const whitespaceRules = new Set([
    '@stylistic/brace-style',
    '@stylistic/eol-last',
    '@stylistic/function-call-spacing',
    '@stylistic/indent',
    '@stylistic/keyword-spacing',
    '@stylistic/linebreak-style',
    '@stylistic/no-multi-spaces',
    '@stylistic/no-trailing-spaces'
]);
const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: path.join(root, 'eslint.config.mjs'),
    fix: (message) => whitespaceRules.has(message.ruleId)
});
for (const relative of paths)
{
    const absolute = path.join(root, relative);
    const before = fs.readFileSync(absolute, 'utf8');
    const [result] = await eslint.lintText(before, { filePath: absolute });
    const after = result.output ?? before;
    assert.equal(javascriptFormatFingerprint(after, relative), javascriptFormatFingerprint(before, relative), relative);
    if (after !== before)
    {
        fs.writeFileSync(absolute, after);
    }
}
