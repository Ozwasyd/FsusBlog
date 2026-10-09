import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const frontendRoot = path.join(repoRoot, 'src/frontend');
const require = createRequire(path.join(frontendRoot, 'package.json'));
const ts = require('typescript');
const vue = require('@vue/language-core');
const { proxyCreateProgram } = require('@volar/typescript/lib/node/proxyCreateProgram');
const { compileScript, parse } = require('@vue/compiler-sfc');
const componentPath = path.join(frontendRoot, 'src/components/security/FsusPoSpaceChallenge.vue');
const probePath = path.join(frontendRoot, 'src/pospaceImportedTypeBindings.static.ts');

// This consumer is checked in memory; neither the component nor its executor is executed.
const probe = `
import FsusPoSpaceChallenge from './components/security/FsusPoSpaceChallenge.vue';
import type {
    SecurityChallengeAssignment,
    SecurityChallengeProviderPayload,
    SecurityChallengeVerifyResponse
} from './api/security';
import type { SecurityChallengeContext } from './security/challenge-client';
import type { SecurityChallengeProof } from './security/challenge-proof-store';

type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type Props = InstanceType<typeof FsusPoSpaceChallenge>['$props'];

export type PoSpaceImportedTypeContract = [
    Assert<Equal<Props['assignment'], SecurityChallengeAssignment | null>>,
    Assert<Equal<Props['providerPayload'], SecurityChallengeProviderPayload | null>>,
    Assert<Equal<Props['context'], SecurityChallengeContext>>,
    Assert<Equal<Parameters<NonNullable<Props['onVerified']>>[0],
        SecurityChallengeProof | SecurityChallengeVerifyResponse>>
];

declare const component: InstanceType<typeof FsusPoSpaceChallenge>;
declare const proof: SecurityChallengeProof;
declare const response: SecurityChallengeVerifyResponse;
component.$emit('verified', proof);
component.$emit('verified', response);
// @ts-expect-error The verified payload must retain the real proof/response contract.
component.$emit('verified', 'invalid-proof');
// @ts-expect-error The original emit names are part of the component contract.
component.$emit('verification', proof);
`;

function componentProgram() {
    const configPath = path.join(frontendRoot, 'tsconfig.app.json');
    const { vueOptions } = vue.createParsedCommandLine(ts, ts.sys, configPath);
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => assert.fail(diagnostic.messageText)
    }, undefined, undefined, vue.getAllExtensions(vueOptions).map((extension) => ({
        extension,
        isMixedContent: true,
        scriptKind: ts.ScriptKind.Deferred
    })));
    assert.ok(parsed);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.options.strict, true);
    assert.ok(parsed.fileNames.includes(componentPath), 'the real app program must include the SFC');
    // vue-tsc recognizes .vue through its patched TS entry; the program API needs this extension flag.
    const options = { ...parsed.options, allowNonTsExtensions: true };
    const host = ts.createCompilerHost(options);
    const originalReadFile = host.readFile;
    const originalFileExists = host.fileExists;
    host.readFile = (file) => file === probePath ? probe : originalReadFile(file);
    host.fileExists = (file) => file === probePath || originalFileExists(file);
    const createProgram = proxyCreateProgram(ts, ts.createProgram, () => [
        vue.createVueLanguagePlugin(ts, options, vueOptions, (id) => id)
    ]);
    return createProgram({
        rootNames: [...parsed.fileNames, probePath],
        options,
        host
    });
}

test('PoSpace props and verified emit bind to the existing imported types in the app program', (context) => {
    const program = componentProgram();
    assert.ok(program.getSourceFile(componentPath), 'the compiler must check the genuine SFC');
    assert.ok(program.getSourceFile(probePath), 'the compiler must check the type consumer');
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const relevant = diagnostics.filter((diagnostic) =>
        !diagnostic.file || [componentPath, probePath].includes(diagnostic.file.fileName));
    assert.deepEqual(relevant.map((diagnostic) => ({
        file: diagnostic.file?.fileName,
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    })), []);
    context.diagnostic(`Unrelated app diagnostics: ${diagnostics.length - relevant.length}; this is a component check, not an app-wide pass.`);
});

test('binding the imported types preserves development and production emitted runtime JavaScript', () => {
    const source = readFileSync(componentPath, 'utf8');
    const { descriptor, errors } = parse(source, { filename: componentPath });
    assert.deepEqual(errors, []);
    const setup = descriptor.scriptSetup;
    assert.ok(setup);
    const aliases = {
        ExecutorAssignment: 'SecurityChallengeAssignment',
        ExecutorProviderPayload: 'SecurityChallengeProviderPayload',
        ExecutorContext: 'SecurityChallengeContext',
        ExecutorProof: 'SecurityChallengeProof',
        ExecutorVerifyResponse: 'SecurityChallengeVerifyResponse'
    };
    // Recreate only the five pre-repair annotations without changing imports or runtime source.
    let restored = 0;
    const unboundSetup = setup.content.replace(
        /\b(ExecutorAssignment|ExecutorProviderPayload|ExecutorContext|ExecutorProof|ExecutorVerifyResponse)\b/gu,
        (name) => {
            restored++;
            return aliases[name];
        }
    );
    assert.equal(restored, 5, 'the comparison must cover all five repaired annotations');
    const before = source.slice(0, setup.loc.start.offset) + unboundSetup + source.slice(setup.loc.end.offset);
    for (const isProd of [false, true]) {
        const emit = (input) => {
            const { descriptor: inputDescriptor, errors: inputErrors } = parse(input, { filename: componentPath });
            assert.deepEqual(inputErrors, []);
            const compiled = compileScript(inputDescriptor, {
                id: 'pospace-imported-type-bindings', isProd, inlineTemplate: true
            });
            return ts.transpileModule(compiled.content, {
                compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
            }).outputText;
        };
        assert.equal(emit(source), emit(before), `runtime JavaScript changed (isProd=${isProd})`);
    }
});
