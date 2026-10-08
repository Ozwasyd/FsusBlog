import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { digestCanonical, sealContentDigest, sha256, validateAggregateAttemptReceipt,
    verifyFileDigest } from './attempt-provenance.mjs';
import { runProducerAttempts } from './attempt-runner.mjs';
import { REPLAY_PLAN_SCHEMA, planExactShards, sealReplayPlan } from './execution-replay-contract.mjs';
import FrontendVitestOutcomeReporter, { nativeModule } from './frontend-vitest-outcome-reporter.mjs';

const { adaptFrontendVitestSemanticOutcome, frontendVitestSuiteIdentity, frontendVitestTestIdentity,
    frontendVitestManifestSchema, frontendVitestEvidenceSchema } = await import(new URL('../test-matrix/outcomes/frontend-vitest-adapter.mjs', import.meta.url));
const moduleFile = fileURLToPath(import.meta.url);
const toolRoot = path.resolve(import.meta.dirname, '../..');
const runnerFile = path.join(import.meta.dirname, 'frontend-vitest-outcome-runner.mjs');
const reporterFile = path.join(import.meta.dirname, 'frontend-vitest-outcome-reporter.mjs');
const astFile = path.join(toolRoot, 'tools/test-inventory/ts-ast-adapter/index.mjs');
const require = createRequire(path.join(path.dirname(astFile), 'package.json'));
const ts = require('typescript');
const printer = ts.createPrinter({ removeComments: true });
const vitestPackageFile = path.join(toolRoot, 'src/frontend/node_modules/vitest/package.json');

export const frontendVitestNativeMaterialSchema = 'fsusblog.frontend-vitest-native-material.v1';

function requireValue(condition, message)
{
    if (!condition)
    {
        throw new Error(`frontend Vitest bridge: ${message}`);
    }
}

function equal(left, right, label)
{
    requireValue(digestCanonical(left) === digestCanonical(right), `${label} mismatch`);
}

function regular(file)
{
    const stat = fs.lstatSync(file);
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
        && fs.realpathSync(file) === path.resolve(file), `source/artifact is not a held regular file: ${file}`);
    return fs.readFileSync(file);
}

function repositoryFile(root, relative)
{
    requireValue(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative)
        && !relative.split(/[\\/]/u).includes('..'), 'repository-relative file required');
    const file = path.resolve(root, relative);
    requireValue(file.startsWith(`${root}${path.sep}`), 'file escapes repository');
    return file;
}

function git(root, args)
{
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
}

function holdSources(root, files, configFile)
{
    const sourceCommit = git(root, ['rev-parse', 'HEAD']).trim();
    const sources = [...new Set([...files, configFile])].sort().map((file) =>
    {
        const bytes = regular(repositoryFile(root, file));
        const tracked = execFileSync('git', ['-C', root, 'show', `${sourceCommit}:${file}`], { maxBuffer: 8 * 1024 * 1024 });
        requireValue(bytes.equals(tracked), `selected source differs from Git HEAD: ${file}`);
        return { file, digest: sha256(bytes) };
    });
    return { sourceCommit, sources };
}

function readEvents(file)
{
    const text = regular(file).toString('utf8');
    requireValue(text === '' || text.endsWith('\n'), 'partial native event journal');
    const events = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    let previousDigest = null;
    events.forEach((entry, sequence) =>
    {
        const { contentDigest, ...unsigned } = entry;
        requireValue(entry.schema === 'fsusblog.frontend-vitest-native-event.v1'
            && entry.sequence === sequence && entry.previousDigest === previousDigest
            && digestCanonical(unsigned) === contentDigest, 'native journal tamper/order');
        previousDigest = contentDigest;
    });
    return events;
}

function printed(node, sourceFile)
{
    return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
}

function nodeAt(sourceFile, span)
{
    const start = sourceFile.getPositionOfLineAndCharacter(span.start.line - 1, span.start.column - 1);
    const end = sourceFile.getPositionOfLineAndCharacter(span.end.line - 1, span.end.column - 1);
    let found = null;
    function visit(node)
    {
        if (node.getStart(sourceFile) === start && node.getEnd() === end)
        {
            found = node;
        }
        if (node.getFullStart() <= start && node.getEnd() >= end)
        {
            ts.forEachChild(node, visit);
        }
    }
    visit(sourceFile);
    requireValue(found !== null, 'canonical AST source span cannot be rebound');
    return found;
}

function literal(node)
{
    if (ts.isStringLiteralLike(node))
    {
        return node.text;
    }
    if (ts.isNumericLiteral(node))
    {
        return Number(node.text);
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
    {
        return node.kind === ts.SyntaxKind.TrueKeyword;
    }
    if (node.kind === ts.SyntaxKind.NullKeyword)
    {
        return null;
    }
    if (ts.isArrayLiteralExpression(node))
    {
        return node.elements.map(literal);
    }
    if (ts.isObjectLiteralExpression(node))
    {
        const entries = node.properties.map((item) =>
        {
            requireValue(ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name)), 'unclosed parameter object');
            return [item.name.text, literal(item.initializer)];
        });
        requireValue(new Set(entries.map(([key]) => key)).size === entries.length, 'duplicate parameter key');
        return Object.fromEntries(entries);
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand))
    {
        return -Number(node.operand.text);
    }
    throw new Error('frontend Vitest bridge: parameter row is not closed literal data');
}

// The canonical owner finds declarations/assertions; this boundary only proves
// that its selected assertions are unconditional, unique direct callback statements.
function sourceBinding(record, sourceFile)
{
    requireValue(record.identity === 'static' && record.bodySpan && record.methodFacts, 'dynamic/unbound source declaration');
    const body = nodeAt(sourceFile, record.bodySpan);
    requireValue(ts.isBlock(body), 'expression-bodied assertion proof is unsupported');
    const assertions = record.methodFacts.assertionCandidates.map((item) =>
    {
        const node = nodeAt(sourceFile, item.location);
        const statement = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent;
        requireValue(ts.isExpressionStatement(statement) && statement.parent === body, 'conditional/nested assertion requires native assertion-location evidence');
        return { source: printed(node, sourceFile), location: item.location };
    });
    requireValue(assertions.length > 0 && new Set(assertions.map((item) => item.source)).size === assertions.length, 'missing or ambiguous source assertions');
    requireValue(!body.statements.some((item) => ts.isReturnStatement(item) || ts.isThrowStatement(item)
        || ts.isIfStatement(item) || ts.isSwitchStatement(item) || ts.isTryStatement(item)
        || ts.isForStatement(item) || ts.isForOfStatement(item) || ts.isForInStatement(item) || ts.isWhileStatement(item)
        || ts.isDoStatement(item)), 'unclosed callback control flow');
    const declarationId = `decl:${digestCanonical(printed(body, sourceFile)).slice(7)}`;
    let caseId = null;
    if (record.kind === 'theory')
    {
        const call = nodeAt(sourceFile, record.sourceSpan);
        const row = record.traits.find((item) => item.name === 'DataRow')?.value;
        requireValue(ts.isCallExpression(call.expression) && /^(0|[1-9][0-9]*)$/u.test(String(row)), 'semantic parameter row requires original row binding');
        const rows = literal(call.expression.arguments[0]);
        requireValue(Array.isArray(rows) && Number(row) < rows.length, 'parameter row missing');
        caseId = `row:${digestCanonical(rows[Number(row)]).slice(7)}`;
    }
    return { declarationId, caseId, assertions, sourceSpan: record.sourceSpan };
}

function extractCanonicalSource(root, files, outputRoot)
{
    const requestFile = path.join(outputRoot, 'ast-request.json');
    fs.writeFileSync(requestFile, JSON.stringify({ root, files: files.map((file) => ({ path: file, adapter: 'vitest' })) }), { flag: 'wx' });
    const result = spawnSync(process.execPath, [astFile, requestFile], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    requireValue(result.status === 0, `original AST adapter failed: ${result.stderr}`);
    const report = JSON.parse(result.stdout);
    requireValue(report.diagnostics.length === 0, 'original AST adapter reports unresolved declarations');
    fs.writeFileSync(path.join(outputRoot, 'ast-report.json'), result.stdout, { flag: 'wx' });
    return report;
}

function registrationLocatorMatches(record, native, sourceFile)
{
    const call = nodeAt(sourceFile, record.sourceSpan);
    requireValue(ts.isCallExpression(call), 'original registration is not a call');
    const positions = [call.expression.getStart(sourceFile)];
    if (ts.isPropertyAccessExpression(call.expression))
    {
        positions.push(call.expression.name.getStart(sourceFile));
    }
    if (ts.isCallExpression(call.expression) && call.arguments.length > 0)
    {
        positions.push(call.expression.getEnd() - 1);
        positions.push(call.expression.getEnd());
        positions.push(call.arguments[0].getStart(sourceFile));
    }
    return positions.some((position) =>
    {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
        return native.location?.line === line + 1 && native.location?.column === character + 1;
    });
}

function bindCollection(root, canonical, nativeModules, { allowPartial = false } = {})
{
    const bindings = [];
    const suites = new Map();
    const used = new Set();
    const sourceFiles = new Map();
    for (const record of canonical.testCases)
    {
        if (!sourceFiles.has(record.ownerFile))
        {
            sourceFiles.set(record.ownerFile, ts.createSourceFile(record.ownerFile,
                regular(repositoryFile(root, record.ownerFile)).toString('utf8'), ts.ScriptTarget.Latest, true));
        }
    }
    for (const module of nativeModules)
    {
        const source = path.relative(root, module.source).replaceAll(path.sep, '/');
        requireValue(module.cases.length > 0 && canonical.testCases.some((record) => record.ownerFile === source), 'extra/empty native module');
        for (const native of module.cases)
        {
            const candidates = canonical.testCases.filter((record) => record.ownerFile === source
                && registrationLocatorMatches(record, native, sourceFiles.get(source))
                && (record.kind !== 'theory' || native.name === record.displayName));
            requireValue(candidates.length === 1 && !used.has(candidates[0].id), `native/source declaration is missing or ambiguous: ${JSON.stringify({ native, declarations: canonical.testCases.map((item) => ({ source: item.ownerFile, span: item.sourceSpan, title: item.displayName, kind: item.kind })) })}`);
            const record = candidates[0];
            used.add(record.id);
            const binding = sourceBinding(record, sourceFiles.get(source));
            const suiteKey = `${source}:${native.parent.taskId}`;
            const suite = suites.get(suiteKey) ?? { source, tests: [], nativeParent: native.parent, members: [] };
            suite.members.push(binding.declarationId);
            const test = { declarationId: binding.declarationId, caseId: binding.caseId, assertionIds: [] };
            suite.tests.push(test);
            suites.set(suiteKey, suite);
            bindings.push({ taskId: native.taskId, source, location: native.location, nativeName: native.name,
                declarationId: binding.declarationId, caseId: binding.caseId,
                test, suite, assertions: binding.assertions, options: native.options });
        }
    }
    requireValue(allowPartial || used.size === canonical.testCases.length, 'canonical/native collection membership mismatch');
    for (const suite of suites.values())
    {
        suite.declarationId = `suite:${digestCanonical({ source: suite.source,
            members: [...new Set(suite.members)].sort() }).slice(7)}`;
        for (const binding of bindings.filter((item) => item.suite === suite))
        {
            binding.testId = frontendVitestTestIdentity(suite, binding.test);
            binding.suiteId = frontendVitestSuiteIdentity(suite);
            binding.test.assertionIds = binding.assertions.map((item) => `assert:${digestCanonical({
                testId: binding.testId, expression: item.source }).slice(7)}`);
        }
    }
    requireValue(new Set(bindings.map((item) => item.testId)).size === bindings.length, 'ambiguous semantic test/case identity');
    return { suites: [...suites.values()].map((suite) => ({ source: suite.source, declarationId: suite.declarationId, tests: suite.tests })),
        bindings: bindings.map((binding) =>
        {
            const result = { ...binding, assertionIds: binding.test.assertionIds };
            delete result.suite;
            delete result.test;
            return result;
        }) };
}

async function createNativeContext(root, configFile, eventFile, nativeReportFile)
{
    const { createVitest, JsonReporter } = await import(new URL('../../src/frontend/node_modules/vitest/dist/node.js', import.meta.url));
    return createVitest('test', { root: path.join(root, 'src/frontend'), config: repositoryFile(root, configFile),
        watch: false, includeTaskLocation: true, runner: runnerFile,
        reporters: [new FrontendVitestOutcomeReporter(eventFile), new JsonReporter({ outputFile: nativeReportFile })] });
}

/** Collect real native declarations and seal a held plan before any test assertion. */
export async function prepareFrontendVitestOutcomeRun({ root, configFile, files, outputRoot, identity, policyDigests, rootSeed })
{
    root = fs.realpathSync(root);
    requireValue(files.length > 0 && new Set(files).size === files.length, 'unique selected source files required');
    fs.mkdirSync(outputRoot, { recursive: false, mode: 0o700 });
    const heldSource = holdSources(root, files, configFile);
    equal(heldSource.sourceCommit, identity.sourceCommit, 'actual Git source identity');
    const canonical = extractCanonicalSource(root, files, outputRoot);
    const collectionFile = path.join(outputRoot, 'collection-events.jsonl');
    const context = await createNativeContext(root, configFile, collectionFile, path.join(outputRoot, 'collection-native.json'));
    let project;
    let collected;
    try
    {
        const collection = await context.collect(files.map((file) => repositoryFile(root, file)));
        requireValue(collection.unhandledErrors.length === 0, 'native collection has unhandled errors');
        collected = collection.testModules.map(nativeModule);
        project = { projectNames: context.projects.map((item) => item.name).sort(),
            coverageEnabled: context.config.coverage.enabled === true };
    }
    finally
    {
        await context.close();
    }
    equal(holdSources(root, files, configFile), heldSource, 'held collection source');
    fs.writeFileSync(path.join(outputRoot, 'collection.json'), JSON.stringify(collected, null, 4), { flag: 'wx', mode: 0o444 });
    const blueprint = bindCollection(root, canonical, collected);
    const vitestVersion = JSON.parse(regular(vitestPackageFile).toString('utf8')).version;
    const replayPlan = sealReplayPlan({ schema: REPLAY_PLAN_SCHEMA,
        source: { commit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint },
        producer: { id: identity.producerId, framework: 'vitest' }, run: { id: identity.schedulerRunId, mode: 'qualification' },
        rootSeed, entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }], randomStreams: [],
        ...planExactShards({ testIds: blueprint.bindings.map((item) => item.testId), shardCount: 1 }),
        workers: { ids: ['frontend-held-worker'], assignmentPolicy: 'framework-owned-after-seal' },
        frameworkModes: [{ name: 'runner-version', value: `vitest-${vitestVersion}` }, { name: 'semantic-observer', value: 'native-count-and-source-proof' }],
        schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false }, schedulerShuffleSeed: 'frontend-held-native-order',
        command: { executable: process.execPath, args: [moduleFile, '--prepared', path.join(outputRoot, 'prepared.json')],
            environmentDigest: identity.executionEnvelopeDigest } });
    const boundIdentity = { ...identity, replayPlanDigest: replayPlan.planDigest };
    const manifest = sealContentDigest({ schema: frontendVitestManifestSchema, identity: boundIdentity,
        configId: `config:${digestCanonical({ file: configFile, digest: heldSource.sources.find((item) => item.file === configFile).digest }).slice(7)}`,
        projectId: `project:${digestCanonical(project.projectNames).slice(7)}`, policyDigests,
        suites: blueprint.suites, coverageIds: [], artifactIds: [] });
    requireValue(project.coverageEnabled === false, 'enabled coverage requires owner-supplied coverage/artifact bindings');
    const prepared = sealContentDigest({ schema: 'fsusblog.frontend-vitest-held-run.v1', root, configFile, files,
        heldSource, project, blueprint, replayPlan, manifest, canonicalDigest: digestCanonical(canonical),
        tools: { astDigest: sha256(regular(astFile)), nodeDigest: sha256(regular(process.execPath)),
            runnerDigest: sha256(regular(runnerFile)), reporterDigest: sha256(regular(reporterFile)), bridgeDigest: sha256(regular(moduleFile)),
            vitestPackageDigest: sha256(regular(vitestPackageFile)),
            vitestVersion, typescriptVersion: ts.version }, qualificationEligible: false });
    fs.writeFileSync(path.join(outputRoot, 'prepared.json'), JSON.stringify(prepared, null, 4), { flag: 'wx', mode: 0o444 });
    return prepared;
}

function validatePrepared(prepared)
{
    equal(sealContentDigest(prepared).contentDigest, prepared.contentDigest, 'held prepared seal');
    requireValue(prepared.schema === 'fsusblog.frontend-vitest-held-run.v1' && prepared.qualificationEligible === false, 'unsupported or promoted prepared material');
    equal(holdSources(prepared.root, prepared.files, prepared.configFile), prepared.heldSource, 'actual selected source');
    for (const [key, file] of [['astDigest', astFile], ['nodeDigest', process.execPath], ['runnerDigest', runnerFile],
        ['reporterDigest', reporterFile], ['bridgeDigest', moduleFile], ['vitestPackageDigest', vitestPackageFile]])
    {
        equal(sha256(regular(file)), prepared.tools[key], `held ${key}`);
    }
}

/** Execute the sealed native selection, retaining raw report and durable real events. */
export async function captureFrontendVitestNativeMaterial(prepared, outputRoot)
{
    validatePrepared(prepared);
    fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    const eventFile = path.join(outputRoot, 'native-events.jsonl');
    const reportFile = path.join(outputRoot, 'native-report.json');
    const context = await createNativeContext(prepared.root, prepared.configFile, eventFile, reportFile);
    try
    {
        await context.start(prepared.files.map((file) => repositoryFile(prepared.root, file)));
    }
    finally
    {
        await context.close();
    }
    validatePrepared(prepared);
    const material = harvestFrontendVitestNativeMaterial(prepared, outputRoot);
    fs.writeFileSync(path.join(outputRoot, 'native-material.json'), JSON.stringify(material, null, 4), { flag: 'wx', mode: 0o444 });
    return material;
}

/** Harvest only observed events; absence after a real abort remains explicitly blocked. */
export function harvestFrontendVitestNativeMaterial(prepared, outputRoot, processOutcome = null)
{
    validatePrepared(prepared);
    const events = readEvents(path.join(outputRoot, 'native-events.jsonl'));
    const collected = events.filter((item) => item.event === 'collected').map((item) => item.value);
    const canonical = JSON.parse(regular(path.join(path.dirname(prepared.replayPlan.command.args[2]), 'ast-report.json')).toString('utf8'));
    equal(digestCanonical(canonical), prepared.canonicalDigest, 'held original AST report');
    const ends = events.filter((item) => item.event === 'end');
    requireValue(ends.length <= 1 && (ends.length === 0 || events.at(-1).event === 'end'), 'duplicate/nonterminal native end');
    const end = ends[0];
    requireValue(end || processOutcome?.signal || processOutcome?.failureKind, 'unfinished native run lacks actual process outcome');
    const aborted = !end || end.value.reason === 'interrupted' || end.value.errors.length > 0;
    const observedBlueprint = bindCollection(prepared.root, canonical, collected, { allowPartial: aborted });
    const plannedNative = new Map(prepared.blueprint.bindings.map((item) => [item.taskId, item]));
    for (const binding of observedBlueprint.bindings)
    {
        const planned = plannedNative.get(binding.taskId);
        requireValue(planned !== undefined, 'extra native collected case');
        for (const field of ['taskId', 'source', 'location', 'nativeName', 'declarationId', 'caseId', 'assertions', 'options'])
        {
            equal(binding[field], planned[field], `actual native/source planned ${field}`);
        }
    }
    if (!aborted)
    {
        equal(observedBlueprint, prepared.blueprint, 'actual native/source complete collection');
    }
    const ready = new Set();
    const results = new Map();
    for (const event of events.filter((item) => item.event === 'ready' || item.event === 'result'))
    {
        const binding = plannedNative.get(event.value.taskId);
        requireValue(binding !== undefined, 'extra native execution event');
        equal({ source: event.value.source, location: event.value.location, name: event.value.name },
            { source: repositoryFile(prepared.root, binding.source), location: binding.location, name: binding.nativeName }, 'native event locator');
        if (event.event === 'ready')
        {
            requireValue(!ready.has(binding.taskId) && !results.has(binding.taskId), 'duplicate/out-of-order native start');
            ready.add(binding.taskId);
        }
        else
        {
            requireValue(!results.has(binding.taskId), 'duplicate native terminal result');
            results.set(binding.taskId, event.value);
        }
    }
    const reportFile = path.join(outputRoot, 'native-report.json');
    const report = fs.existsSync(reportFile) ? JSON.parse(regular(reportFile).toString('utf8')) : null;
    const tests = prepared.blueprint.bindings.map((binding) =>
    {
        const actual = results.get(binding.taskId);
        const state = actual?.result.state;
        requireValue(state === undefined || ['passed', 'failed', 'skipped', 'pending'].includes(state), 'unknown native terminal state');
        const status = { passed: 'passed', failed: 'failed', skipped: 'skipped' }[state] ?? 'blocked';
        const calls = actual?.observation?.assertionCalls ?? null;
        const issues = [];
        if (binding.options.concurrent)
        {
            issues.push('concurrent-assertions-need-local-expect-proof');
        }
        requireValue(status !== 'passed' && status !== 'failed' || ready.has(binding.taskId), 'native terminal result lacks execution start');
        if (status === 'passed' && (calls !== binding.assertionIds.length || actual.observation?.tries !== 1))
        {
            issues.push('native-assertion-count-or-try-mismatch');
        }
        if (status === 'failed')
        {
            issues.push('native-failure-needs-exact-assertion-location-and-blocked-tail-contract');
        }
        const executed = ready.has(binding.taskId) && binding.options.mode !== 'skip' && binding.options.mode !== 'todo';
        if (status === 'skipped' && executed)
        {
            issues.push('dynamic-skip-after-start-needs-executed-skip-contract');
        }
        return { testId: binding.testId, suiteId: binding.suiteId, taskId: binding.taskId,
            status, executed, assertionIds: binding.assertionIds,
            assertionCalls: calls, native: actual ?? null, bindingIssues: issues };
    });
    requireValue(results.size === tests.filter((item) => item.native !== null).length, 'extra native terminal result');
    return sealContentDigest({ schema: frontendVitestNativeMaterialSchema, preparedDigest: prepared.contentDigest,
        manifestDigest: prepared.manifest.contentDigest, replayPlanDigest: prepared.replayPlan.planDigest,
        sourceCommit: prepared.heldSource.sourceCommit, completion: aborted ? 'aborted' : 'complete',
        report, reportDigest: report === null ? null : digestCanonical(report), eventsDigest: digestCanonical(events),
        events, bindings: prepared.blueprint.bindings, tests, processOutcome,
        qualificationEligible: false, verificationStatus: 'native-observed' });
}

/** Use the original attempt process owner; its external authority verification remains mandatory. */
export async function runFrontendVitestOutcomeAttempts(prepared, input)
{
    validatePrepared(prepared);
    const command = [prepared.replayPlan.command.executable, ...prepared.replayPlan.command.args];
    requireValue(input.producerId === prepared.manifest.identity.producerId, 'attempt crosses producer');
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId'])
    {
        equal(input[field], prepared.manifest.identity[field], `attempt ${field}`);
    }
    return runProducerAttempts({ ...input, command, cwd: path.join(prepared.root, 'src/frontend'),
        expectedTestIds: prepared.replayPlan.testEnumerationOrder });
}

/** Build adapter input only after original qualified attempt and independently held artifacts verify. */
export function bindFrontendVitestHeldOutcome({ prepared, material, aggregate, loadAttempt,
    verifyAuthority, verifyArtifact, artifactRoot, expectedPreparedDigest, expectedMaterialDigest, hostExpectedLimits })
{
    validatePrepared(prepared);
    equal(prepared.contentDigest, expectedPreparedDigest, 'independent prepared digest');
    equal(material.contentDigest, expectedMaterialDigest, 'independent native material digest');
    equal(sealContentDigest(material).contentDigest, material.contentDigest, 'native material seal');
    equal(material.preparedDigest, prepared.contentDigest, 'native held run');
    requireValue(typeof verifyArtifact === 'function', 'original artifact verifier is mandatory');
    validateAggregateAttemptReceipt(aggregate, { loadAttempt, verifyAuthority, verifyArtifact });
    requireValue(aggregate.cleanFirstAttempt === true && aggregate.qualificationEligible === true
        && aggregate.attempts.length === 1, 'original attempt is unqualified');
    const attempt = loadAttempt(aggregate.attempts[0]);
    for (const file of ['native-events.jsonl', 'native-report.json', 'native-material.json', 'result.json'])
    {
        requireValue(attempt.artifactPaths.includes(file) && verifyFileDigest(artifactRoot, file, attempt.artifactDigests[file]), 'actual attempt artifact bytes mismatch');
        regular(path.join(artifactRoot, file));
    }
    equal(JSON.parse(regular(path.join(artifactRoot, 'native-material.json')).toString('utf8')), material, 'actual held material bytes');
    equal(harvestFrontendVitestNativeMaterial(prepared, artifactRoot), material, 'actual journal/report rederivation');
    equal(attempt.command, [prepared.replayPlan.command.executable, ...prepared.replayPlan.command.args], 'actual attempt command');
    requireValue(material.report !== null && material.completion === 'complete'
        && material.tests.every((item) => item.bindingIssues.length === 0), 'native binding remains incomplete');
    const identity = prepared.manifest.identity;
    equal(attempt.executedTestIds, material.tests.filter((item) => item.executed).map((item) => item.testId).sort(), 'actual attempt executed topology');
    equal(attempt.failedTestIds, material.tests.filter((item) => item.status === 'failed').map((item) => item.testId).sort(), 'actual attempt failed topology');
    for (const field of ['sourceCommit', 'worktreeFingerprint', 'schedulerRunId', 'producerId',
        'executionEnvelopeDigest', 'replayPlanDigest', 'temporalContextDigest'])
    {
        equal(attempt[field], identity[field], `actual attempt ${field}`);
    }
    const attemptEligibility = { aggregateDigest: aggregate.contentDigest, attemptDigest: attempt.contentDigest,
        attemptNumber: attempt.attemptNumber, cleanFirstAttempt: aggregate.cleanFirstAttempt,
        firstFailure: attempt.firstFailure, qualificationEligible: aggregate.qualificationEligible };
    const fileIndices = new Map(material.report.testResults.map((file, index) => [path.resolve(file.name), index]));
    const usedNative = new Set();
    const tests = material.tests.map((item) =>
    {
        const binding = material.bindings.find((entry) => entry.testId === item.testId);
        const fileIndex = fileIndices.get(repositoryFile(prepared.root, binding.source));
        requireValue(fileIndex !== undefined, 'actual native report file missing');
        const matches = material.report.testResults[fileIndex].assertionResults.map((entry, index) => ({ entry, index }))
            .filter(({ entry }) => entry.location?.line === binding.location.line
                && entry.location?.column === binding.location.column && entry.title === binding.nativeName);
        requireValue(matches.length === 1, 'actual native result binding ambiguous');
        const key = `${fileIndex}:${matches[0].index}`;
        requireValue(!usedNative.has(key), 'duplicate native result binding');
        usedNative.add(key);
        return { testId: item.testId, status: item.status, executed: item.executed,
            nativeRef: { fileIndex, assertionIndex: matches[0].index },
            assertions: item.assertionIds.map((id) => ({ id, status: item.status, failure: null })) };
    });
    const suiteBindings = prepared.manifest.suites.map((suite) => ({ suiteId: frontendVitestSuiteIdentity(suite),
        fileIndex: fileIndices.get(repositoryFile(prepared.root, suite.source)) }));
    const evidence = sealContentDigest({ schema: frontendVitestEvidenceSchema, identity,
        configId: prepared.manifest.configId, projectId: prepared.manifest.projectId, policyDigests: prepared.manifest.policyDigests,
        attemptEligibility, manifestDigest: prepared.manifest.contentDigest, reportDigest: digestCanonical(material.report),
        completion: 'complete', suiteBindings, tests, coverageIds: [], artifacts: [] });
    return adaptFrontendVitestSemanticOutcome({ identity, attemptEligibility, replayPlan: prepared.replayPlan,
        manifest: prepared.manifest, report: material.report, evidence,
        expectedInputs: { identity, attemptEligibility, replayPlanDigest: prepared.replayPlan.planDigest,
            manifestDigest: prepared.manifest.contentDigest, reportDigest: digestCanonical(material.report),
            evidenceDigest: evidence.contentDigest, hostExpectedLimits } });
}

async function main()
{
    requireValue(process.argv.length === 4 && process.argv[2] === '--prepared', 'expected --prepared <held file>');
    const prepared = JSON.parse(regular(path.resolve(process.argv[3])).toString('utf8'));
    const outputRoot = process.env.FSUSBLOG_ATTEMPT_ARTIFACT_ROOT;
    const resultFile = process.env.FSUSBLOG_ATTEMPT_RESULT_PATH;
    requireValue(outputRoot && resultFile, 'original attempt runner artifact/result paths required');
    const material = await captureFrontendVitestNativeMaterial(prepared, outputRoot);
    const failed = material.tests.filter((item) => item.status === 'failed');
    const incomplete = material.tests.some((item) => item.bindingIssues.length > 0 || item.status === 'blocked');
    fs.writeFileSync(resultFile, JSON.stringify({ schema: 'fsusblog.test-attempt-result.v1',
        failureClass: failed.length > 0 || incomplete ? 'contract' : null,
        failureKind: failed.length > 0 || incomplete ? 'native-outcome-binding-incomplete' : null,
        executedTestIds: material.tests.filter((item) => item.executed).map((item) => item.testId).sort(),
        failedTestIds: failed.map((item) => item.testId).sort(),
        artifactPaths: ['native-events.jsonl', 'native-report.json', 'native-material.json'] }), { flag: 'wx' });
    if (failed.length > 0 || incomplete)
    {
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile)
{
    try
    {
        await main();
    }
    catch (error)
    {
        process.stderr.write(`${error.stack}\n`);
        process.exitCode = 1;
    }
}
