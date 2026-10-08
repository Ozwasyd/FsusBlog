import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCallerOwnerBinding } from './command-wrapper-caller-binding.mjs';
import { observeCommandWrapperCompileBinding } from './command-wrapper-compile-binding.mjs';
import { validateClosedOwnedCliAst } from './command-wrapper-input-ast.mjs';

const authorityRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registryPath = 'config/development/command-wrapper-input-registry.json';
const registeredFile = 'tools/test/native/execution-envelope-landlock.c';
const schema = 'fsusblog.command-wrapper-input-registry.v1';

function sha256(bytes)
{
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function regularBytes(root, relative)
{
    assert.ok(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.split('/').includes('..'), 'invalid owner path');
    const absolute = path.join(root, relative);
    const resolvedRoot = fs.realpathSync(root);
    assert.equal(fs.realpathSync(absolute), path.join(resolvedRoot, relative), 'owner path redirected');
    assert.ok(fs.lstatSync(absolute).isFile(), 'owner is not a regular file');
    assert.ok(fs.statSync(absolute).size <= 16 * 1024 * 1024, 'owner source exceeds input bound');
    return fs.readFileSync(absolute);
}

function exactKeys(value, keys, description)
{
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${description} must be an object`);
    assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${description} fields drifted`);
}

function loadRegistry()
{
    // Authority is always the checker's own checkout, never a candidate-supplied declaration.
    const registryText = regularBytes(authorityRoot, registryPath).toString('utf8');
    const registry = JSON.parse(registryText);
    assert.equal(registryText, `${JSON.stringify(registry, null, 4)}\n`, 'input registry must be canonical JSON without duplicate keys');
    exactKeys(registry, ['schema', 'issue', 'models'], 'native command input registry');
    assert.equal(registry.schema, schema, 'unknown native command input registry');
    assert.equal(registry.issue, 3638, 'foreign command input governance owner');
    assert.equal(registry.models?.length, 1, 'missing, duplicate or widened command input model');
    const model = registry.models[0];
    exactKeys(model, ['id', 'file', 'ownedInputClasses', 'selectionPolicy', 'compileBinding', 'callerOwnerBinding', 'analyzer', 'components', 'compileDatabaseCandidates'], 'command input model');
    assert.equal(model.id, 'correctness-landlock-cli', 'unknown command input model');
    assert.equal(model.file, registeredFile, 'foreign translation unit input model');
    assert.deepEqual(model.ownedInputClasses, ['main.argc', 'main.argv'], 'widened controlled input classes');
    assert.deepEqual(model.compileDatabaseCandidates, [
        '.tmp/cmake/native-basic', '.tmp/cmake/native-speed', '.tmp/cmake/native-asan-ubsan', '.tmp/cmake/native-fuzz', 'src/frontend/wasm/build'
    ], 'foreign compile database owners');
    exactKeys(model.analyzer, ['path', 'realPath', 'sha256', 'version', 'configuration', 'taintSources'], 'command input analyzer');
    const expectedComponents = [
        'tools/style/command-wrapper-input-ast.mjs', 'tools/style/command-wrapper-compile-binding.mjs', 'tools/style/command-wrapper-caller-binding.mjs',
        'tools/style/command-wrapper-input-model.mjs', 'tools/style/check-native-tooling-style.mjs'
    ];
    assert.deepEqual(model.components?.map(component => component.path).sort(), expectedComponents.sort(), 'input authority component closure drift');
    for (const component of model.components)
    {
        exactKeys(component, ['path', 'sha256'], 'input authority component');
        assert.match(component.sha256, /^[a-f0-9]{64}$/u, 'invalid component digest');
        assert.equal(sha256(regularBytes(authorityRoot, component.path)), component.sha256, 'input authority component drift');
    }
    return model;
}

function validateSelectionPolicy(root, model, policyFile)
{
    exactKeys(model.selectionPolicy, ['path', 'sha256'], 'command input selection policy');
    assert.equal(model.selectionPolicy.path, 'config/development/native-tooling-style-policy.json', 'foreign command input selection policy');
    assert.equal(policyFile, path.join(root, model.selectionPolicy.path), 'redirected command input selection policy');
    for (const owner of [authorityRoot, root])
    {
        assert.equal(sha256(regularBytes(owner, model.selectionPolicy.path)), model.selectionPolicy.sha256, 'command input selection policy drift');
    }
}

export function isMandatoryCommandWrapperInput(file, argumentsValue)
{
    return file === registeredFile && argumentsValue.requireTools === true && argumentsValue.operation === 'lint';
}

/** Required-tools admission must not be erased by candidate exclusions, domains, or hash debt. */
export function validateCommandWrapperInputSelection({ root, argumentsValue, selected, policyPath })
{
    if (!argumentsValue.requireTools || argumentsValue.operation !== 'lint'
        || !['native', 'all'].includes(argumentsValue.domain))
    {
        return;
    }
    const requested = argumentsValue.files.map(file => path.relative(root, path.resolve(root, file)).split(path.sep).join('/'));
    const fullRegisteredRoot = argumentsValue.mode === 'full' && argumentsValue.files.length === 0 && fs.existsSync(path.join(root, registeredFile));
    if (!requested.includes(registeredFile) && !selected.includes(registeredFile) && !fullRegisteredRoot)
    {
        return;
    }
    const model = loadRegistry();
    validateSelectionPolicy(root, model, policyPath);
    assert.ok(selected.includes(registeredFile), 'canonical registered TU was excluded before required input admission');
}

function observeAnalyzer(model)
{
    assert.ok(path.isAbsolute(model.path) && path.isAbsolute(model.realPath), 'unbound analyzer path');
    assert.equal(fs.realpathSync(model.path), model.realPath, 'analyzer path drift');
    assert.ok(fs.lstatSync(model.realPath).isFile(), 'analyzer is not regular');
    assert.equal(sha256(fs.readFileSync(model.realPath)), model.sha256, 'analyzer byte drift');
    const result = spawnSync(model.path, ['--version'], { encoding: 'utf8', timeout: 30_000,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' } });
    assert.equal(result.status, 0, 'analyzer identity query failed');
    assert.equal(result.stdout.trim(), model.version, 'analyzer version drift');
}

function matchingEntries(root, file, databases)
{
    const absolute = path.join(root, file);
    return databases.flatMap(database => (database.entries ?? []).filter(entry =>
    {
        const entryFile = path.isAbsolute(entry.file) ? path.resolve(entry.file) : path.resolve(entry.directory ?? database.directory, entry.file);
        return entryFile === absolute;
    }).map(entry => ({ database, entry })));
}

/** Returns a TU-local analyzer argument plan only after every independent input owner is admitted. */
export function prepareCommandWrapperInputModel({ root, file, databases, cppLintPolicy, environment })
{
    if (file !== registeredFile)
    {
        return null;
    }
    const model = loadRegistry();
    validateSelectionPolicy(root, model, path.join(root, model.selectionPolicy.path));
    assert.equal(cppLintPolicy.command, 'clang-tidy', 'registered analyzer command drift');
    assert.equal(cppLintPolicy.configuration, '.clang-tidy', 'registered analyzer configuration drift');
    assert.deepEqual(cppLintPolicy.compileDatabaseCandidates, model.compileDatabaseCandidates, 'registered compile database selection drift');
    const matches = matchingEntries(root, file, databases);
    assert.equal(matches.length, 1, 'registered TU requires exactly one canonical compile entry');
    const { database, entry } = matches[0];
    assert.ok(model.compileDatabaseCandidates.some(relative => path.resolve(root, relative) === database.directory), 'foreign canonical compile database');
    const databaseRelative = path.relative(root, path.join(database.directory, 'compile_commands.json'));
    const databaseBytes = regularBytes(root, databaseRelative);
    const parsedDatabase = JSON.parse(databaseBytes.toString('utf8'));
    assert.deepEqual(parsedDatabase, database.entries, 'compile database changed after selection');
    assert.ok([2, 4].some(indentation => databaseBytes.toString('utf8') === `${JSON.stringify(parsedDatabase, null, indentation)}\n`),
        'canonical compile database must not contain duplicate JSON keys or unsupported formatting');
    const databaseSha256 = sha256(databaseBytes);
    const sourceBytes = regularBytes(root, file);
    const sourceSha256 = sha256(sourceBytes);
    const caller = validateCallerOwnerBinding(root, model);
    const compiled = observeCommandWrapperCompileBinding({ root, file, entry, policy: model.compileBinding, environment });
    const ast = validateClosedOwnedCliAst(typeof compiled.ast === 'string' ? JSON.parse(compiled.ast) : compiled.ast, {
        sourceBytes, sourceFile: path.join(root, file)
    });
    observeAnalyzer(model.analyzer);
    const configuration = model.analyzer.configuration;
    const taintSources = model.analyzer.taintSources;
    for (const input of [configuration, taintSources])
    {
        exactKeys(input, ['path', 'sha256'], 'analyzer model source');
        assert.equal(sha256(regularBytes(authorityRoot, input.path)), input.sha256, 'authority analyzer model source drift');
        assert.equal(sha256(regularBytes(root, input.path)), input.sha256, 'candidate analyzer model source drift');
    }
    assert.equal(configuration.path, '.clang-tidy', 'foreign analyzer configuration');
    assert.equal(taintSources.path, 'config/development/command-wrapper-taint-sources.yml', 'foreign taint source configuration');
    assert.equal(sourceSha256, sha256(regularBytes(root, file)), 'translation unit changed during input admission');
    const privateDirectory = fs.mkdtempSync(path.join(root, '.tmp/command-wrapper-analysis-'));
    fs.chmodSync(privateDirectory, 0o700);
    const privateDatabaseFile = path.join(privateDirectory, 'compile_commands.json');
    const privateDatabaseBytes = Buffer.from(`${JSON.stringify([entry], null, 4)}\n`);
    try
    {
        fs.writeFileSync(privateDatabaseFile, privateDatabaseBytes, { flag: 'wx', mode: 0o400 });
    }
    catch (error)
    {
        fs.rmSync(privateDirectory, { recursive: true, force: false });
        throw error;
    }
    const extraArguments = [
        `--config-file=${path.join(authorityRoot, configuration.path)}`,
        '--extra-arg=-Xclang', '--extra-arg=-analyzer-config', '--extra-arg=-Xclang', '--extra-arg=assume-controlled-environment=true',
        '--extra-arg=-Xclang', '--extra-arg=-analyzer-config', '--extra-arg=-Xclang',
        `--extra-arg=optin.taint.TaintPropagation:Config=${path.join(authorityRoot, taintSources.path)}`
    ];
    return {
        analyzerPath: model.analyzer.path, extraArguments, sourceSha256, compileDirectory: privateDirectory,
        analyzerEnvironment: { ...model.compileBinding.environment },
        evidence: { caller, compile: compiled.binding, ast, qualificationEligible: false, policyPromotion: false },
        revalidate()
        {
            loadRegistry();
            validateSelectionPolicy(root, model, path.join(root, model.selectionPolicy.path));
            observeAnalyzer(model.analyzer);
            assert.ok(typeof compiled.revalidate === 'function', 'compile binding lacks post-analysis revalidation');
            compiled.revalidate();
            assert.equal(sha256(regularBytes(root, databaseRelative)), databaseSha256, 'canonical compile database changed during analyzer execution');
            assert.ok(fs.lstatSync(privateDirectory).isDirectory() && (fs.lstatSync(privateDirectory).mode & 0o7777) === 0o700,
                'private compile database owner mode drift');
            assert.equal(fs.realpathSync(privateDirectory), privateDirectory, 'private compile database owner redirected');
            const privateMetadata = fs.lstatSync(privateDatabaseFile);
            assert.ok(privateMetadata.isFile() && (privateMetadata.mode & 0o7777) === 0o400, 'private compile database mode or type drift');
            assert.deepEqual(fs.readFileSync(privateDatabaseFile), privateDatabaseBytes, 'private admitted compile database changed during analyzer execution');
            validateCallerOwnerBinding(root, model);
            assert.equal(sha256(regularBytes(root, file)), sourceSha256, 'translation unit changed during analyzer execution');
            for (const input of [configuration, taintSources])
            {
                assert.equal(sha256(regularBytes(authorityRoot, input.path)), input.sha256, 'authority analyzer model changed during execution');
                assert.equal(sha256(regularBytes(root, input.path)), input.sha256, 'candidate analyzer model changed during execution');
            }
        },
        cleanup()
        {
            // This directory was created exclusively for this admitted analyzer invocation.
            fs.rmSync(privateDirectory, { recursive: true, force: false });
        }
    };
}
