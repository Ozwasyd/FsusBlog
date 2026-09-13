#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readReleaseReliabilityEvidenceBinding } from './release-reliability-evidence-binding.mjs';

const knownStatuses = ['CompileError', 'Ignored', 'Killed', 'NoCoverage', 'Survived', 'Timeout'];
const executedStatuses = new Set(['Killed', 'Survived', 'Timeout']);
const terminalStatuses = new Set(knownStatuses);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const supportedStrykerNetVersion = '4.14.2';

// Reviewed against dotnet-stryker@4.14.2.
// Source revision: cc7fdf3433025a4b63c2c091c07b2177d117359e.
function strykerNet4142OperatorAllowlist()
{
    const operators = new Set([
        'Arithmetic mutation',
        'Array initializer mutation',
        'Bitwise mutation',
        'Block removal mutation',
        'Boolean mutation',
        'Collection expression mutation',
        'Collection initializer mutation',
        'Conditional (false) mutation',
        'Conditional (true) mutation',
        'Equality mutation',
        'Logical mutation',
        'Negate expression',
        'Null coalescing mutation (left to right)',
        'Null coalescing mutation (remove left)',
        'Null coalescing mutation (remove right)',
        'Object initializer mutation',
        'Remove checked expression',
        'Statement mutation',
        'String mutation',
        'Regex Unicode character class negation mutation',
        'Regex anchor removal mutation',
        'Regex capturing group to non-capturing group modification',
        'Regex character class child removal',
        'Regex character class negation mutation',
        'Regex character class range modification',
        'Regex character class shorthand negation mutation',
        'Regex character class subtraction removal',
        'Regex character class subtraction replacement',
        'Regex character class to "[\\w\\W]" change',
        'Regex greedy quantifier quantity mutation',
        'Regex greedy quantifier to reluctant quantifier modification',
        'Regex predefined character class nullification',
        'Regex predefined character class to character class with its negation change',
        'Regex quantifier removal mutation'
    ]);
    const directedPairs = [
        ['AddAssignmentExpression', ['SubtractAssignmentExpression']],
        ['SubtractAssignmentExpression', ['AddAssignmentExpression']],
        ['MultiplyAssignmentExpression', ['DivideAssignmentExpression']],
        ['DivideAssignmentExpression', ['MultiplyAssignmentExpression']],
        ['ModuloAssignmentExpression', ['MultiplyAssignmentExpression']],
        ['AndAssignmentExpression', [
            'OrAssignmentExpression',
            'ExclusiveOrAssignmentExpression'
        ]],
        ['OrAssignmentExpression', [
            'AndAssignmentExpression',
            'ExclusiveOrAssignmentExpression'
        ]],
        ['ExclusiveOrAssignmentExpression', [
            'OrAssignmentExpression',
            'AndAssignmentExpression'
        ]],
        ['LeftShiftAssignmentExpression', [
            'RightShiftAssignmentExpression',
            'UnsignedRightShiftAssignmentExpression'
        ]],
        ['RightShiftAssignmentExpression', [
            'LeftShiftAssignmentExpression',
            'UnsignedRightShiftAssignmentExpression'
        ]],
        ['CoalesceAssignmentExpression', ['SimpleAssignmentExpression']],
        ['UnsignedRightShiftAssignmentExpression', [
            'LeftShiftAssignmentExpression',
            'RightShiftAssignmentExpression'
        ]],
        ['UnaryMinusExpression', ['UnaryPlusExpression']],
        ['UnaryPlusExpression', ['UnaryMinusExpression']],
        ['PreIncrementExpression', ['PreDecrementExpression']],
        ['PreDecrementExpression', ['PreIncrementExpression']],
        ['PostIncrementExpression', ['PostDecrementExpression']],
        ['PostDecrementExpression', ['PostIncrementExpression']]
    ];
    for (const [original, replacements] of directedPairs)
    {
        for (const replacement of replacements)
        {
            operators.add(`${original} to ${replacement} mutation`);
        }
    }
    operators.add('BitwiseNotExpression to un-BitwiseNotExpression mutation');
    operators.add('LogicalNotExpression to un-LogicalNotExpression mutation');

    const linqPairs = [
        ['FirstOrDefault', 'First'],
        ['First', 'FirstOrDefault'],
        ['SingleOrDefault', 'Single'],
        ['Single', 'SingleOrDefault'],
        ['Last', 'First'],
        ['All', 'Any'],
        ['Any', 'All'],
        ['Skip', 'Take'],
        ['Take', 'Skip'],
        ['SkipWhile', 'TakeWhile'],
        ['TakeWhile', 'SkipWhile'],
        ['Min', 'Max'],
        ['Max', 'Min'],
        ['Sum', 'Max'],
        ['Count', 'Sum'],
        ['Average', 'Min'],
        ['OrderBy', 'OrderByDescending'],
        ['OrderByDescending', 'OrderBy'],
        ['ThenBy', 'ThenByDescending'],
        ['ThenByDescending', 'ThenBy'],
        ['Reverse', 'AsEnumerable'],
        ['AsEnumerable', 'Reverse'],
        ['Union', 'Intersect'],
        ['Intersect', 'Union'],
        ['Concat', 'Except'],
        ['Except', 'Concat'],
        ['MinBy', 'MaxBy'],
        ['MaxBy', 'MinBy'],
        ['SkipLast', 'TakeLast'],
        ['TakeLast', 'SkipLast'],
        ['Order', 'OrderDescending'],
        ['OrderDescending', 'Order'],
        ['UnionBy', 'IntersectBy'],
        ['IntersectBy', 'UnionBy'],
        ['Append', 'Prepend'],
        ['Prepend', 'Append']
    ];
    for (const [original, replacement] of linqPairs)
    {
        operators.add(`Linq method mutation (${original}() to ${replacement}())`);
    }

    const mathPairs = [
        ['Acos', ['Acosh', 'Asin', 'Atan']],
        ['Acosh', ['Acos', 'Asinh', 'Atanh']],
        ['Asin', ['Asinh', 'Acos', 'Atan']],
        ['Asinh', ['Asin', 'Acosh', 'Atanh']],
        ['Atan', ['Atanh', 'Acos', 'Asin']],
        ['Atanh', ['Atan', 'Acosh', 'Asinh']],
        ['BitDecrement', ['BitIncrement']],
        ['BitIncrement', ['BitDecrement']],
        ['Ceiling', ['Floor']],
        ['Cos', ['Cosh', 'Sin', 'Tan']],
        ['Cosh', ['Cos', 'Sinh', 'Tanh']],
        ['Exp', ['Log']],
        ['Floor', ['Ceiling']],
        ['Log', ['Exp', 'Pow']],
        ['MaxMagnitude', ['MinMagnitude']],
        ['MinMagnitude', ['MaxMagnitude']],
        ['Pow', ['Log']],
        ['ReciprocalEstimate', ['ReciprocalSqrtEstimate']],
        ['ReciprocalSqrtEstimate', ['ReciprocalEstimate', 'Sqrt']],
        ['Sin', ['Sinh', 'Cos', 'Tan']],
        ['Sinh', ['Sin', 'Cosh', 'Tanh']],
        ['Tan', ['Tanh', 'Cos', 'Sin']],
        ['Tanh', ['Tan', 'Cosh', 'Sinh']]
    ];
    for (const [original, replacements] of mathPairs)
    {
        for (const replacement of replacements)
        {
            operators.add(`Math method mutation (${original}() to ${replacement}())`);
        }
    }

    const stringMethodPairs = [
        ['EndsWith', 'StartsWith'],
        ['StartsWith', 'EndsWith'],
        ['TrimStart', 'TrimEnd'],
        ['TrimEnd', 'TrimStart'],
        ['ToUpper', 'ToLower'],
        ['ToLower', 'ToUpper'],
        ['ToUpperInvariant', 'ToLowerInvariant'],
        ['ToLowerInvariant', 'ToUpperInvariant'],
        ['PadLeft', 'PadRight'],
        ['PadRight', 'PadLeft'],
        ['IndexOf', 'LastIndexOf'],
        ['LastIndexOf', 'IndexOf']
    ];
    for (const [original, replacement] of stringMethodPairs)
    {
        operators.add(`String Method Mutation (Replace ${original}() with ${replacement}())`);
    }
    operators.add('String Method Mutation (Replace Trim() with Empty String)');
    operators.add('String Method Mutation (Replace Substring() with Empty String)');
    operators.add("String Method Mutation (Replace ElementAt() with '\\0' char)");
    operators.add("String Method Mutation (Replace ElementAtOrDefault() with '\\0' char)");
    return operators;
}

const supportedStrykerNetOperators = strykerNet4142OperatorAllowlist();

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object')
    {
        const fields = Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
        return `{${fields.join(',')}}`;
    }
    return JSON.stringify(value);
}

function requireText(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!normalized)
    {
        throw new Error(`${label} is required`);
    }
    return normalized;
}

function requireExactStringProperty(object, property, label, { allowEmpty = false } = {})
{
    if (!object || typeof object !== 'object' || !Object.hasOwn(object, property))
    {
        throw new Error(`${label} is required`);
    }
    const value = object[property];
    if (typeof value !== 'string')
    {
        throw new Error(`${label} must be a string`);
    }
    if (!allowEmpty && value.length === 0)
    {
        throw new Error(`${label} must not be empty`);
    }
    return value;
}

function supportedStrykerOperator(mutant, label, strykerVersion)
{
    if (strykerVersion !== supportedStrykerNetVersion)
    {
        throw new Error(`unsupported Stryker.NET producer version ${strykerVersion}`);
    }
    const operator = requireExactStringProperty(mutant, 'mutatorName', `${label} operator`);
    if (!supportedStrykerNetOperators.has(operator))
    {
        throw new Error(
            `${label} operator is not in the Stryker.NET ${supportedStrykerNetVersion} allowlist: `
            + JSON.stringify(operator)
        );
    }
    return operator;
}

function requireSourceState(sourceState)
{
    const commit = String(sourceState?.commit ?? '').trim();
    const worktreeFingerprint = String(sourceState?.worktreeFingerprint ?? '').trim();
    if (!/^[0-9a-f]{40}$/u.test(commit))
    {
        throw new Error('producer sourceState.commit must be a 40-character lowercase Git SHA');
    }
    if (!/^[0-9a-f]{64}$/u.test(worktreeFingerprint))
    {
        throw new Error('producer sourceState.worktreeFingerprint must be a SHA-256 digest');
    }
    return { commit, worktreeFingerprint };
}

function requireGeneratedAt(value)
{
    const generatedAt = requireText(value, 'producer generatedAt');
    if (!Number.isFinite(Date.parse(generatedAt)))
    {
        throw new Error('producer generatedAt must be an ISO date-time');
    }
    return generatedAt;
}

function normalizedUniqueStrings(value, label, { allowEmpty = false } = {})
{
    if (!Array.isArray(value))
    {
        throw new Error(`${label} must be an array`);
    }
    const normalized = value.map((entry) => requireText(entry, `${label} entry`));
    if (!allowEmpty && normalized.length === 0)
    {
        throw new Error(`${label} must not be empty`);
    }
    const sorted = [...normalized].sort((left, right) => left.localeCompare(right));
    if (new Set(sorted).size !== sorted.length)
    {
        throw new Error(`${label} must be unique`);
    }
    return sorted;
}

function normalizedLocation(location, label)
{
    const start = location?.start;
    const end = location?.end;
    const fields = [
        ['startLine', start?.line],
        ['startColumn', start?.column],
        ['endLine', end?.line],
        ['endColumn', end?.column]
    ];
    const result = {};
    for (const [name, value] of fields)
    {
        if (!Number.isInteger(value) || value < 1)
        {
            throw new Error(`${label} ${name} is required`);
        }
        result[name] = value;
    }
    if (
        result.endLine < result.startLine
        || (result.endLine === result.startLine && result.endColumn < result.startColumn)
    )
    {
        throw new Error(`${label} location is invalid`);
    }
    return result;
}

function repoRelativeSourceFile(file, repositoryRoot, sourceRoot)
{
    const root = resolve(repositoryRoot ?? process.cwd());
    const normalizedSourceRoot = sourceRoot ? resolve(root, sourceRoot) : root;
    const normalizedFile = file.replaceAll('\\', '/');
    const relativeSourceRoot = sourceRoot
        ? relative(root, normalizedSourceRoot).split(sep).join('/')
        : '';
    const absolute = isAbsolute(file)
        ? resolve(file)
        : relativeSourceRoot && normalizedFile.startsWith(`${relativeSourceRoot}/`)
            ? resolve(root, normalizedFile)
            : resolve(normalizedSourceRoot, file);
    const result = relative(root, absolute);
    if (!result || result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result))
    {
        throw new Error(`mutant source file must be repository-relative: ${file}`);
    }
    return result.split(sep).join('/');
}

function sourceSlice(source, location, label)
{
    const lines = [];
    let lineStartOffset = 0;
    for (const newline of source.matchAll(/\r\n|\r|\n/gu))
    {
        lines.push({
            startOffset: lineStartOffset,
            text: source.slice(lineStartOffset, newline.index)
        });
        lineStartOffset = newline.index + newline[0].length;
    }
    lines.push({
        startOffset: lineStartOffset,
        text: source.slice(lineStartOffset)
    });
    if (
        location.endLine > lines.length
        || location.startColumn > lines[location.startLine - 1].text.length + 1
        || location.endColumn > lines[location.endLine - 1].text.length + 1
    )
    {
        throw new Error(`${label} location is outside source content`);
    }
    const startOffset = lines[location.startLine - 1].startOffset + location.startColumn - 1;
    const endOffset = lines[location.endLine - 1].startOffset + location.endColumn - 1;
    const original = source.slice(startOffset, endOffset);
    if (!original)
    {
        throw new Error(`${label} original source range is empty`);
    }
    return original;
}

function globMatches(pattern, input)
{
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
        .replaceAll('**/', '(?:.*/)?')
        .replaceAll('**', '.*')
        .replaceAll('*', '[^/]*')
        .replaceAll('?', '[^/]');
    return new RegExp(`^${escaped}$`, 'u').test(input);
}

function configuredTestFilterMatches(testCaseFilter, fullyQualifiedName)
{
    const filters = testCaseFilter.split('|').map((entry) => entry.trim());
    if (
        filters.length === 0
        || filters.some((entry) => !/^FullyQualifiedName~.+$/u.test(entry))
    )
    {
        throw new Error('Stryker test-case-filter must use FullyQualifiedName~<test identity> clauses');
    }
    return filters.some((entry) => fullyQualifiedName.includes(entry.slice('FullyQualifiedName~'.length)));
}

function rawMutantRecords(report)
{
    const records = [];
    const rawIds = new Set();
    for (const [file, fileRecord] of Object.entries(report.files ?? {}))
    {
        if (!Array.isArray(fileRecord?.mutants))
        {
            throw new Error(`Stryker report file ${file} must contain mutants`);
        }
        for (const mutant of fileRecord.mutants)
        {
            const rawMutantId = requireText(mutant?.id, `mutant raw ID in ${file}`);
            if (rawIds.has(rawMutantId))
            {
                throw new Error(`Stryker report contains duplicate raw mutant ID ${rawMutantId}`);
            }
            rawIds.add(rawMutantId);
            if (!terminalStatuses.has(mutant?.status))
            {
                throw new Error(`Stryker report contains unknown mutant status ${mutant?.status}`);
            }
            records.push({ file, fileRecord, mutant, rawMutantId });
        }
    }
    return records;
}

function buildTestIdentityMap(report)
{
    if (!report.testFiles || typeof report.testFiles !== 'object')
    {
        throw new Error('Stryker report must contain testFiles for actual test identity resolution');
    }
    const identities = new Map();
    for (const [file, testFile] of Object.entries(report.testFiles))
    {
        const tests = testFile?.tests ?? [];
        if (!Array.isArray(tests))
        {
            throw new Error(`Stryker report test file ${file} tests must be an array`);
        }
        for (const testCase of tests)
        {
            const rawTestId = requireText(testCase?.id, `raw test ID in ${file}`);
            if (!uuidPattern.test(rawTestId))
            {
                throw new Error(`raw test ID ${rawTestId} in ${file} must be a GUID`);
            }
            if (identities.has(rawTestId))
            {
                throw new Error(`Stryker report contains duplicate raw test ID ${rawTestId}`);
            }
            identities.set(rawTestId, requireText(testCase?.name, `test FQN for ${rawTestId}`));
        }
    }
    return identities;
}

function resolveTestBindings(rawTestIds, testIdentities, label)
{
    const normalizedRawIds = normalizedUniqueStrings(rawTestIds, label, { allowEmpty: true });
    return normalizedRawIds.map((rawTestId) =>
    {
        const fullyQualifiedName = testIdentities.get(rawTestId);
        if (!fullyQualifiedName)
        {
            throw new Error(`${label} references unknown raw test ID ${rawTestId}`);
        }
        return { rawTestId, fullyQualifiedName };
    });
}

function testNames(bindings)
{
    return [...new Set(bindings.map(({ fullyQualifiedName }) => fullyQualifiedName))]
        .sort((left, right) => left.localeCompare(right));
}

function traceTimestampNanoseconds(value, label)
{
    const match = value.match(
        /^(?<second>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,9}))?(?<zone>Z|[+-]\d{2}:\d{2})$/u
    );
    if (!match?.groups)
    {
        throw new Error(`${label} is not a supported ISO timestamp`);
    }
    const wholeMilliseconds = Date.parse(`${match.groups.second}${match.groups.zone}`);
    if (!Number.isFinite(wholeMilliseconds))
    {
        throw new Error(`${label} is not a valid ISO timestamp`);
    }
    const fraction = (match.groups.fraction ?? '').padEnd(9, '0');
    return BigInt(wholeMilliseconds) * 1_000_000n + BigInt(fraction || '0');
}

function traceDurationMs(startedAt, completedAt, label)
{
    const durationNanoseconds = traceTimestampNanoseconds(completedAt, `${label} completedAt`)
        - traceTimestampNanoseconds(startedAt, `${label} startedAt`);
    if (durationNanoseconds <= 0n)
    {
        throw new Error(`${label} trace timestamps are reversed or zero-length`);
    }
    const durationMs = Number((Number(durationNanoseconds) / 1_000_000).toFixed(6));
    if (!Number.isFinite(durationMs) || durationMs <= 0)
    {
        throw new Error(`${label} trace durationMs must be finite and positive`);
    }
    return durationMs;
}

function traceMutantIds(label, context)
{
    const ids = [];
    const pattern = /(?:^|,)\s*(?<rawMutantId>[A-Za-z0-9._-]+):\s*/gu;
    for (const match of label.matchAll(pattern))
    {
        ids.push(match.groups.rawMutantId);
    }
    if (ids.length === 0)
    {
        throw new Error(`${context} does not contain raw mutant IDs`);
    }
    if (new Set(ids).size !== ids.length)
    {
        throw new Error(`${context} contains duplicate raw mutant IDs`);
    }
    return ids;
}

function normalizedTraceLabel(value)
{
    return value.replace(/,\s*/gu, ',').trim();
}

function outcomeMatchesStatus(outcome, status)
{
    const normalized = outcome.toLowerCase().replace(/[\s_-]+/gu, '');
    if (status === 'Killed')
    {
        return normalized === 'failed';
    }
    if (status === 'Survived')
    {
        return ['passed', 'success', 'succeeded'].includes(normalized);
    }
    if (status === 'Timeout')
    {
        return ['timeout', 'timedout'].includes(normalized);
    }
    return false;
}

function traceOption(optionsLine, name)
{
    const match = optionsLine.match(new RegExp(`\\b${name}: "([^"]+)"`, 'u'));
    if (!match)
    {
        throw new Error(`Stryker trace is missing ${name}`);
    }
    return match[1];
}

function parseStrykerTrace({
    rawTrace,
    rawReportSha256,
    reportAbsolutePath,
    testCaseFilter,
    rawMutants
})
{
    const trace = Buffer.isBuffer(rawTrace) ? rawTrace.toString('utf8') : String(rawTrace ?? '');
    if (!trace.trim())
    {
        throw new Error('raw Stryker trace is empty');
    }
    const lines = trace.split(/\r?\n/u);
    const versionRecords = lines
        .map((line) => line.match(
            /^\S+\s+\[DBG\]\s+Stryker starting, version: "(?<version>[^"]+)"\s+\([0-9a-f]+\)\s*$/u
        ))
        .filter(Boolean);
    if (versionRecords.length !== 1)
    {
        throw new Error('Stryker trace must contain exactly one producer version record');
    }
    const strykerVersion = versionRecords[0].groups.version;
    if (strykerVersion !== supportedStrykerNetVersion)
    {
        throw new Error(
            `unsupported Stryker.NET producer version ${strykerVersion}; `
            + `expected ${supportedStrykerNetVersion}`
        );
    }
    const optionsLines = lines.filter((line) => line.includes('Stryker started with options:'));
    if (optionsLines.length !== 1)
    {
        throw new Error('Stryker trace must contain exactly one run options record');
    }
    const reportDirectory = traceOption(optionsLines[0], 'ReportPath');
    const reportFileName = traceOption(optionsLines[0], 'ReportFileName');
    const tracedTestCaseFilter = traceOption(optionsLines[0], 'TestCaseFilter');
    const tracedReportPath = resolve(
        reportDirectory,
        reportFileName.endsWith('.json') ? reportFileName : `${reportFileName}.json`
    );
    if (tracedReportPath !== resolve(reportAbsolutePath))
    {
        throw new Error(`Stryker trace is bound to a different report: ${tracedReportPath}`);
    }
    if (tracedTestCaseFilter !== testCaseFilter)
    {
        throw new Error('Stryker trace test-case-filter does not match current config');
    }

    const scoreLines = lines
        .map((line) => line.match(/The final mutation score is (?<score>\d+(?:\.\d+)?) %/u))
        .filter(Boolean);
    if (scoreLines.length !== 1)
    {
        throw new Error('Stryker trace must contain exactly one final mutation score');
    }
    const finalScore = Number(scoreLines[0].groups.score);
    if (!Number.isFinite(finalScore))
    {
        throw new Error('Stryker trace final mutation score is invalid');
    }

    const rawMutantsById = new Map(rawMutants.map((record) => [record.rawMutantId, record]));
    const activeByRunner = new Map();
    const activeByLabel = new Map();
    const seenRawMutantIds = new Set();
    const batches = [];

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1)
    {
        const line = lines[lineNumber];
        const start = line.match(
            /^(?<timestamp>\S+)\s+\[DBG\]\s+"(?<runner>Runner [^"]+)": Testing (?<batch>\[.*\]) \([0-9a-f]+\)\s*$/u
        );
        if (start?.groups)
        {
            const { timestamp, runner } = start.groups;
            if (activeByRunner.has(runner))
            {
                throw new Error(`Stryker trace runner ${runner} started a new batch before its prior terminal event`);
            }
            let encodedEntries;
            try
            {
                encodedEntries = JSON.parse(start.groups.batch);
            }
            catch
            {
                throw new Error(`Stryker trace batch at line ${lineNumber + 1} is not valid JSON`);
            }
            if (
                !Array.isArray(encodedEntries)
                || encodedEntries.length === 0
                || encodedEntries.some((entry) => typeof entry !== 'string' || !entry.trim())
            )
            {
                throw new Error(`Stryker trace batch at line ${lineNumber + 1} is invalid`);
            }
            const rawLabel = encodedEntries.join(',');
            const rawMutantIds = traceMutantIds(rawLabel, `Stryker trace batch at line ${lineNumber + 1}`);
            for (const rawMutantId of rawMutantIds)
            {
                const record = rawMutantsById.get(rawMutantId);
                if (!record)
                {
                    throw new Error(`Stryker trace contains unknown raw mutant ID ${rawMutantId}`);
                }
                if (!executedStatuses.has(record.mutant.status))
                {
                    throw new Error(`Stryker trace executed non-executable raw mutant ID ${rawMutantId}`);
                }
                if (seenRawMutantIds.has(rawMutantId))
                {
                    throw new Error(`Stryker trace executes raw mutant ID ${rawMutantId} more than once`);
                }
                seenRawMutantIds.add(rawMutantId);
            }
            const normalizedLabel = normalizedTraceLabel(rawLabel);
            if (activeByLabel.has(normalizedLabel))
            {
                throw new Error(`Stryker trace contains concurrent duplicate batch label ${normalizedLabel}`);
            }
            const active = {
                runnerId: runner,
                normalizedLabel,
                rawMutantIds,
                startedAt: timestamp,
                startLine: lineNumber + 1
            };
            activeByRunner.set(runner, active);
            activeByLabel.set(normalizedLabel, active);
            continue;
        }

        const terminal = line.match(
            /^(?<timestamp>\S+)\s+\[DBG\]\s+Test run for "(?<label>.*)" is "(?<outcome>[^"]+)"\s+\([0-9a-f]+\)\s*$/u
        );
        if (!terminal?.groups)
        {
            continue;
        }
        const normalizedLabel = normalizedTraceLabel(terminal.groups.label);
        const active = activeByLabel.get(normalizedLabel);
        if (!active)
        {
            throw new Error(`Stryker trace contains an orphan or duplicate terminal batch at line ${lineNumber + 1}`);
        }
        const statuses = [...new Set(active.rawMutantIds.map(
            (rawMutantId) => rawMutantsById.get(rawMutantId).mutant.status
        ))];
        if (
            statuses.length !== 1
            || !outcomeMatchesStatus(terminal.groups.outcome, statuses[0])
        )
        {
            throw new Error(`Stryker trace batch at line ${active.startLine} is not terminal-consistent with its report statuses`);
        }
        const durationMs = traceDurationMs(
            active.startedAt,
            terminal.groups.timestamp,
            `Stryker trace batch at line ${active.startLine}`
        );
        const batchIdentity = {
            runnerId: active.runnerId,
            rawMutantIds: [...active.rawMutantIds].sort((left, right) => left.localeCompare(right)),
            startedAt: active.startedAt,
            completedAt: terminal.groups.timestamp,
            outcome: terminal.groups.outcome,
            durationMs
        };
        batches.push({
            batchId: sha256(canonicalJson(batchIdentity)),
            ...batchIdentity
        });
        activeByRunner.delete(active.runnerId);
        activeByLabel.delete(normalizedLabel);
    }

    if (activeByRunner.size > 0)
    {
        const unfinished = [...activeByRunner.values()]
            .map(({ rawMutantIds }) => rawMutantIds.join(','))
            .join('; ');
        throw new Error(`Stryker trace contains unterminated mutant batches: ${unfinished}`);
    }

    const expectedExecutedIds = rawMutants
        .filter(({ mutant }) => executedStatuses.has(mutant.status))
        .map(({ rawMutantId }) => rawMutantId)
        .sort((left, right) => left.localeCompare(right));
    const tracedExecutedIds = [...seenRawMutantIds].sort((left, right) => left.localeCompare(right));
    if (canonicalJson(expectedExecutedIds) !== canonicalJson(tracedExecutedIds))
    {
        const missing = expectedExecutedIds.filter((rawMutantId) => !seenRawMutantIds.has(rawMutantId));
        throw new Error(`Stryker trace does not cover the report's executed mutant set; missing=${missing.join(',') || 'none'}`);
    }

    batches.sort((left, right) =>
        left.startedAt.localeCompare(right.startedAt)
        || left.batchId.localeCompare(right.batchId)
    );
    const timingByRawMutantId = new Map();
    for (const batch of batches)
    {
        for (const rawMutantId of batch.rawMutantIds)
        {
            timingByRawMutantId.set(rawMutantId, {
                durationMs: batch.durationMs,
                durationState: 'trace-measured',
                traceBatchId: batch.batchId
            });
        }
    }
    return {
        strykerVersion,
        finalScore,
        batches,
        batchDigest: sha256(canonicalJson(batches)),
        rawReportSha256,
        timingByRawMutantId
    };
}

function normalizeMutant({
    file,
    fileRecord,
    mutant,
    rawMutantId,
    repositoryRoot,
    sourceRoot,
    testIdentities,
    timingByRawMutantId,
    strykerVersion
})
{
    const label = `mutant ${rawMutantId} in ${file}`;
    const source = requireExactStringProperty(
        fileRecord,
        'source',
        `${label} source content`
    );
    const location = normalizedLocation(mutant.location, label);
    const operator = supportedStrykerOperator(mutant, label, strykerVersion);
    const replacement = requireExactStringProperty(
        mutant,
        'replacement',
        `${label} replacement`,
        { allowEmpty: true }
    );
    const sourceFile = repoRelativeSourceFile(file, repositoryRoot, sourceRoot);
    const coveredByTestBindings = resolveTestBindings(
        mutant.coveredBy ?? [],
        testIdentities,
        `${label} coveredBy`
    );
    const killedByTestBindings = resolveTestBindings(
        mutant.killedBy ?? [],
        testIdentities,
        `${label} killedBy`
    );
    const coveredRawIds = new Set(coveredByTestBindings.map(({ rawTestId }) => rawTestId));
    if (mutant.status === 'Killed' && killedByTestBindings.length === 0)
    {
        throw new Error(`${label} killed mutant must have a killing test ID`);
    }
    if (mutant.status !== 'Killed' && killedByTestBindings.length > 0)
    {
        throw new Error(`${label} non-killed mutant cannot have killing test IDs`);
    }
    if (executedStatuses.has(mutant.status) && coveredByTestBindings.length === 0)
    {
        throw new Error(`${label} executed mutant must have covered test IDs`);
    }
    if (
        mutant.status === 'NoCoverage'
        && (coveredByTestBindings.length > 0 || killedByTestBindings.length > 0)
    )
    {
        throw new Error(`${label} NoCoverage mutant cannot have test IDs`);
    }
    if (!killedByTestBindings.every(({ rawTestId }) => coveredRawIds.has(rawTestId)))
    {
        throw new Error(`${label} killing test IDs must be covered test IDs`);
    }

    let durationMs = null;
    let durationState;
    let traceBatchId = null;
    if (executedStatuses.has(mutant.status))
    {
        const timing = timingByRawMutantId.get(rawMutantId);
        if (!timing)
        {
            throw new Error(`${label} executed mutant is missing trace-bound durationMs`);
        }
        durationMs = timing.durationMs;
        durationState = timing.durationState;
        traceBatchId = timing.traceBatchId;
    }
    else if (mutant.status === 'CompileError')
    {
        durationState = 'not-reported-for-compile-error';
    }
    else
    {
        durationState = 'not-executed';
    }

    const original = sourceSlice(source, location, label);
    const identity = {
        sourceFile,
        sourceFileDigest: sha256(source),
        operator,
        ...location,
        originalDigest: sha256(original),
        replacementDigest: sha256(replacement)
    };
    return {
        mutantId: sha256(canonicalJson(identity)),
        rawMutantId,
        ...identity,
        status: mutant.status,
        coveredByTestIds: testNames(coveredByTestBindings),
        killedByTestIds: testNames(killedByTestBindings),
        coveredByTestBindings,
        killedByTestBindings,
        durationMs,
        durationState,
        traceBatchId
    };
}

function semanticMutantIdentity(mutant)
{
    return {
        sourceFile: mutant.sourceFile,
        sourceFileDigest: mutant.sourceFileDigest,
        operator: mutant.operator,
        startLine: mutant.startLine,
        startColumn: mutant.startColumn,
        endLine: mutant.endLine,
        endColumn: mutant.endColumn,
        originalDigest: mutant.originalDigest,
        replacementDigest: mutant.replacementDigest
    };
}

function semanticMutantInventoryDigest(inventory)
{
    return sha256(canonicalJson(inventory
        .map(semanticMutantIdentity)
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))));
}

function validateDurationContracts(inventory)
{
    for (const mutant of inventory)
    {
        if (executedStatuses.has(mutant.status))
        {
            if (
                !Number.isFinite(mutant.durationMs)
                || mutant.durationMs <= 0
                || mutant.durationState !== 'trace-measured'
                || !/^[0-9a-f]{64}$/u.test(mutant.traceBatchId ?? '')
            )
            {
                throw new Error(`executed mutant ${mutant.mutantId} has an invalid trace duration contract`);
            }
            continue;
        }
        const expectedState = mutant.status === 'CompileError'
            ? 'not-reported-for-compile-error'
            : 'not-executed';
        if (
            mutant.durationMs !== null
            || mutant.durationState !== expectedState
            || mutant.traceBatchId !== null
        )
        {
            throw new Error(`non-executed mutant ${mutant.mutantId} has an invalid duration state`);
        }
    }
}

function mutationInventory(report, options)
{
    const inventory = rawMutantRecords(report).map((record) => normalizeMutant({
        ...record,
        ...options
    }));
    inventory.sort((left, right) => left.mutantId.localeCompare(right.mutantId));
    if (new Set(inventory.map(({ mutantId }) => mutantId)).size !== inventory.length)
    {
        throw new Error('Stryker report contains duplicate canonical mutant ID');
    }
    validateDurationContracts(inventory);
    return inventory;
}

function inventoryCollections(inventory, testCaseFilter)
{
    const byStatus = Object.fromEntries(knownStatuses.map((status) => [status, []]));
    const executedTestIds = new Set();
    for (const mutant of inventory)
    {
        byStatus[mutant.status].push(mutant.mutantId);
        if (!executedStatuses.has(mutant.status))
        {
            continue;
        }
        for (const testId of mutant.coveredByTestIds)
        {
            if (!configuredTestFilterMatches(testCaseFilter, testId))
            {
                throw new Error(`actual test ID ${testId} does not match configured test-case-filter`);
            }
            executedTestIds.add(testId);
        }
    }
    const collections = {
        plannedMutantIds: inventory.map(({ mutantId }) => mutantId),
        executedMutantIds: [...byStatus.Killed, ...byStatus.Survived, ...byStatus.Timeout].sort(),
        compileErrorMutantIds: byStatus.CompileError,
        ignoredMutantIds: byStatus.Ignored,
        noCoverageMutantIds: byStatus.NoCoverage,
        killedMutantIds: byStatus.Killed,
        survivedMutantIds: byStatus.Survived,
        timeoutMutantIds: byStatus.Timeout,
        executedTestIds: [...executedTestIds].sort((left, right) => left.localeCompare(right))
    };
    validateInventoryCollections(inventory, collections);
    return collections;
}

export function validateInventoryCollections(inventory, collections)
{
    const expectedByStatus = Object.fromEntries(knownStatuses.map((status) => [
        status,
        inventory
            .filter((mutant) => mutant.status === status)
            .map(({ mutantId }) => mutantId)
            .sort((left, right) => left.localeCompare(right))
    ]));
    const expected = {
        plannedMutantIds: inventory
            .map(({ mutantId }) => mutantId)
            .sort((left, right) => left.localeCompare(right)),
        executedMutantIds: [
            ...expectedByStatus.Killed,
            ...expectedByStatus.Survived,
            ...expectedByStatus.Timeout
        ].sort((left, right) => left.localeCompare(right)),
        compileErrorMutantIds: expectedByStatus.CompileError,
        ignoredMutantIds: expectedByStatus.Ignored,
        noCoverageMutantIds: expectedByStatus.NoCoverage,
        killedMutantIds: expectedByStatus.Killed,
        survivedMutantIds: expectedByStatus.Survived,
        timeoutMutantIds: expectedByStatus.Timeout,
        executedTestIds: [...new Set(inventory
            .filter((mutant) => executedStatuses.has(mutant.status))
            .flatMap((mutant) => mutant.coveredByTestIds))]
            .sort((left, right) => left.localeCompare(right))
    };
    for (const [name, expectedValues] of Object.entries(expected))
    {
        const actualValues = collections?.[name];
        if (
            !Array.isArray(actualValues)
            || new Set(actualValues).size !== actualValues.length
            || canonicalJson([...actualValues].sort((left, right) => left.localeCompare(right)))
                !== canonicalJson(expectedValues)
        )
        {
            throw new Error(`${name} does not match the actual terminal mutant inventory`);
        }
    }
}

function validateScope(scope, inventory, sourceRoot)
{
    const normalizedRoot = sourceRoot
        ? `${sourceRoot.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')}/`
        : '';
    const actualFiles = [...new Set(inventory.map(({ sourceFile }) => sourceFile))];
    for (const file of actualFiles)
    {
        const scopedFile = normalizedRoot && file.startsWith(normalizedRoot)
            ? file.slice(normalizedRoot.length)
            : file;
        if (!scope.some((pattern) => globMatches(pattern, scopedFile)))
        {
            throw new Error(`actual mutated source file ${file} is outside configured mutate scope`);
        }
    }
    for (const pattern of scope)
    {
        if (!actualFiles.some((file) =>
        {
            const scopedFile = normalizedRoot && file.startsWith(normalizedRoot)
                ? file.slice(normalizedRoot.length)
                : file;
            return globMatches(pattern, scopedFile);
        }))
        {
            throw new Error(`configured mutate scope ${pattern} has no actual mutant source file`);
        }
    }
}

export function validateStrykerReport(report)
{
    if (!report || typeof report !== 'object' || report.schemaVersion !== '2')
    {
        throw new Error('Stryker report must use schemaVersion 2');
    }
    if (!report.files || typeof report.files !== 'object')
    {
        throw new Error('Stryker report must contain files');
    }
    const records = rawMutantRecords(report);
    const statuses = Object.fromEntries(knownStatuses.map((status) => [
        status,
        records.filter(({ mutant }) => mutant.status === status).length
    ]));
    const executedMutants = [...executedStatuses]
        .reduce((total, status) => total + statuses[status], 0);
    if (executedMutants === 0)
    {
        throw new Error('Stryker report must execute at least one mutant');
    }
    const thresholds = report.thresholds;
    if (!thresholds || !Number.isFinite(thresholds.high) || !Number.isFinite(thresholds.low))
    {
        throw new Error('Stryker report must declare numeric high and low thresholds');
    }
    return {
        schemaVersion: report.schemaVersion,
        executedMutants,
        statuses,
        thresholds: { high: thresholds.high, low: thresholds.low }
    };
}

function rawJsonBytes(value, rawValue, label)
{
    const bytes = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue ?? '');
    if (bytes.length === 0)
    {
        throw new Error(`${label} is empty`);
    }
    let parsed;
    try
    {
        parsed = JSON.parse(bytes);
    }
    catch
    {
        throw new Error(`${label} is not valid JSON`);
    }
    if (canonicalJson(parsed) !== canonicalJson(value))
    {
        throw new Error(`${label} content does not match the supplied parsed value`);
    }
    return bytes;
}

function executionMatrix(inventory)
{
    return inventory.map((mutant) => ({
        mutantId: mutant.mutantId,
        rawMutantId: mutant.rawMutantId,
        status: mutant.status,
        coveredByTestIds: mutant.coveredByTestIds,
        killedByTestIds: mutant.killedByTestIds,
        coveredByTestBindings: mutant.coveredByTestBindings,
        killedByTestBindings: mutant.killedByTestBindings,
        durationMs: mutant.durationMs,
        durationState: mutant.durationState,
        traceBatchId: mutant.traceBatchId
    }));
}

function referencedTestIdentities(inventory)
{
    const identities = new Map();
    for (const mutant of inventory)
    {
        for (const binding of [
            ...mutant.coveredByTestBindings,
            ...mutant.killedByTestBindings
        ])
        {
            const existing = identities.get(binding.rawTestId);
            if (existing && existing !== binding.fullyQualifiedName)
            {
                throw new Error(`raw test ID ${binding.rawTestId} resolves to conflicting FQNs`);
            }
            identities.set(binding.rawTestId, binding.fullyQualifiedName);
        }
    }
    return [...identities]
        .map(([rawTestId, fullyQualifiedName]) => ({ rawTestId, fullyQualifiedName }))
        .sort((left, right) => left.rawTestId.localeCompare(right.rawTestId));
}

export function createStrykerAuthority({
    report,
    rawReport,
    rawParsedReport = report,
    reportPath,
    reportAbsolutePath,
    rawTrace,
    tracePath,
    config,
    rawConfig,
    configPath,
    tierId,
    runId,
    sourceState,
    generatedAt,
    repositoryRoot = process.cwd(),
    sourceRoot,
    releaseReliability = null
})
{
    const summary = validateStrykerReport(report);
    const reportBytes = rawJsonBytes(rawParsedReport, rawReport, 'raw Stryker report');
    const configBytes = rawJsonBytes(config, rawConfig, 'raw Stryker config');
    const traceBytes = Buffer.isBuffer(rawTrace) ? rawTrace : Buffer.from(rawTrace ?? '');
    if (traceBytes.length === 0)
    {
        throw new Error('raw Stryker trace is empty');
    }

    const strykerConfig = config?.['stryker-config'];
    if (!strykerConfig || typeof strykerConfig !== 'object')
    {
        throw new Error('Stryker config must contain stryker-config');
    }
    const scope = Array.isArray(strykerConfig.mutate)
        ? strykerConfig.mutate.map((entry) => requireText(entry, 'Stryker mutate scope entry'))
        : [];
    if (scope.length === 0)
    {
        throw new Error('Stryker config must declare a non-empty mutate scope');
    }
    const testCaseFilter = requireText(strykerConfig['test-case-filter'], 'Stryker test-case-filter');
    const rawMutants = rawMutantRecords(report);
    const reportDigest = sha256(reportBytes);
    const traceExecution = parseStrykerTrace({
        rawTrace: traceBytes,
        rawReportSha256: reportDigest,
        reportAbsolutePath: reportAbsolutePath ?? (
            isAbsolute(reportPath)
                ? reportPath
                : resolve(repositoryRoot, reportPath)
        ),
        testCaseFilter,
        rawMutants
    });
    const testIdentities = buildTestIdentityMap(report);
    const inventory = mutationInventory(report, {
        repositoryRoot,
        sourceRoot,
        testIdentities,
        timingByRawMutantId: traceExecution.timingByRawMutantId,
        strykerVersion: traceExecution.strykerVersion
    });
    validateScope(scope, inventory, sourceRoot);
    const collections = inventoryCollections(inventory, testCaseFilter);

    const configuredThresholds = strykerConfig.thresholds;
    if (
        !configuredThresholds
        || !Number.isFinite(configuredThresholds.high)
        || !Number.isFinite(configuredThresholds.low)
        || !Number.isFinite(configuredThresholds.break)
    )
    {
        throw new Error('Stryker config must declare numeric high, low, and break thresholds');
    }
    for (const name of ['high', 'low'])
    {
        if (configuredThresholds[name] !== summary.thresholds[name])
        {
            throw new Error(`Stryker report ${name} threshold does not match current config`);
        }
    }

    const scoreableMutants = summary.statuses.Killed
        + summary.statuses.NoCoverage
        + summary.statuses.Survived
        + summary.statuses.Timeout;
    if (scoreableMutants === 0)
    {
        throw new Error('Stryker report must contain scoreable mutants');
    }
    const score = Number(((summary.statuses.Killed / scoreableMutants) * 100).toFixed(4));
    if (score < configuredThresholds.break)
    {
        throw new Error(`Stryker mutation score ${score} is below break threshold ${configuredThresholds.break}`);
    }
    if (Number(score.toFixed(2)) !== traceExecution.finalScore)
    {
        throw new Error('Stryker trace final score does not match the raw report');
    }

    const normalizedTierId = requireText(tierId, 'tierId');
    const normalizedRunId = requireText(runId, 'producer runId');
    const normalizedSourceState = requireSourceState(sourceState);
    const normalizedGeneratedAt = requireGeneratedAt(generatedAt);
    const batches = traceExecution.batches;
    const authority = {
        schema: 'fsusblog.stryker-authority.v1',
        status: 'success',
        tierId: normalizedTierId,
        sliceId: normalizedTierId,
        commandAlias: normalizedTierId === 'release-mutation-critical-slice'
            ? 'backend-mutation-critical'
            : normalizedTierId,
        evidenceClass: normalizedTierId === 'release-mutation-critical-slice'
            ? 'source-level'
            : 'unclassified',
        score,
        mutantCount: Object.values(summary.statuses).reduce((total, count) => total + count, 0),
        executedMutants: summary.executedMutants,
        statuses: summary.statuses,
        inventory,
        testIdentities: referencedTestIdentities(inventory),
        ...collections,
        inventoryDigest: sha256(canonicalJson(inventory)),
        semanticMutantIdentityDigest: semanticMutantInventoryDigest(inventory),
        executionMatrixDigest: sha256(canonicalJson(executionMatrix(inventory))),
        sourceRoot: sourceRoot ?? null,
        scope,
        testCaseFilter,
        thresholds: {
            high: configuredThresholds.high,
            low: configuredThresholds.low,
            break: configuredThresholds.break
        },
        rawReport: {
            path: requireText(reportPath, 'raw report path'),
            sha256: reportDigest
        },
        rawTrace: {
            path: requireText(tracePath, 'raw trace path'),
            sha256: sha256(traceBytes)
        },
        traceExecution: {
            strykerVersion: traceExecution.strykerVersion,
            rawReportSha256: traceExecution.rawReportSha256,
            finalScore: traceExecution.finalScore,
            batchDigest: traceExecution.batchDigest,
            batches
        },
        config: {
            path: requireText(configPath, 'config path'),
            sha256: sha256(configBytes)
        },
        producer: {
            runId: normalizedRunId,
            sourceState: normalizedSourceState,
            generatedAt: normalizedGeneratedAt
        },
        ...(releaseReliability === null ? {} : { releaseReliability })
    };
    validateStrykerAuthorityShape(authority);
    return authority;
}

function validateStrykerAuthorityShape(authority)
{
    if (authority?.schema !== 'fsusblog.stryker-authority.v1' || authority.status !== 'success')
    {
        throw new Error('Stryker authority schema/status is invalid');
    }
    if (!Array.isArray(authority.inventory))
    {
        throw new Error('Stryker authority inventory is required');
    }
    validateDurationContracts(authority.inventory);
    validateInventoryCollections(authority.inventory, authority);
    if (authority.inventoryDigest !== sha256(canonicalJson(authority.inventory)))
    {
        throw new Error('Stryker authority inventoryDigest mismatch');
    }
    for (const mutant of authority.inventory)
    {
        if (mutant.mutantId !== sha256(canonicalJson(semanticMutantIdentity(mutant))))
        {
            throw new Error(`Stryker authority mutant ${mutant.mutantId} semantic identity mismatch`);
        }
    }
    if (authority.semanticMutantIdentityDigest !== semanticMutantInventoryDigest(authority.inventory))
    {
        throw new Error('Stryker authority semanticMutantIdentityDigest mismatch');
    }
    if (authority.executionMatrixDigest !== sha256(canonicalJson(executionMatrix(authority.inventory))))
    {
        throw new Error('Stryker authority executionMatrixDigest mismatch');
    }
    if (authority.traceExecution?.rawReportSha256 !== authority.rawReport?.sha256)
    {
        throw new Error('Stryker authority trace/report digest binding mismatch');
    }
    if (authority.traceExecution?.strykerVersion !== supportedStrykerNetVersion)
    {
        throw new Error(
            `Stryker authority producer version must be ${supportedStrykerNetVersion}`
        );
    }
    const batches = authority.traceExecution?.batches;
    if (!Array.isArray(batches))
    {
        throw new Error('Stryker authority trace batches are required');
    }
    if (authority.traceExecution.batchDigest !== sha256(canonicalJson(batches)))
    {
        throw new Error('Stryker authority trace batch digest mismatch');
    }
    const batchByRawMutantId = new Map();
    for (const batch of batches)
    {
        if (batch.batchId !== sha256(canonicalJson({
            runnerId: batch.runnerId,
            rawMutantIds: batch.rawMutantIds,
            startedAt: batch.startedAt,
            completedAt: batch.completedAt,
            outcome: batch.outcome,
            durationMs: batch.durationMs
        })))
        {
            throw new Error(`Stryker authority trace batch ${batch.batchId} identity mismatch`);
        }
        for (const rawMutantId of batch.rawMutantIds)
        {
            if (batchByRawMutantId.has(rawMutantId))
            {
                throw new Error(`Stryker authority trace duplicates raw mutant ID ${rawMutantId}`);
            }
            batchByRawMutantId.set(rawMutantId, batch);
        }
    }
    for (const mutant of authority.inventory)
    {
        const batch = batchByRawMutantId.get(mutant.rawMutantId);
        if (executedStatuses.has(mutant.status))
        {
            if (
                !batch
                || batch.batchId !== mutant.traceBatchId
                || batch.durationMs !== mutant.durationMs
            )
            {
                throw new Error(`Stryker authority mutant ${mutant.mutantId} trace batch mismatch`);
            }
            batchByRawMutantId.delete(mutant.rawMutantId);
        }
        else if (batch)
        {
            throw new Error(`Stryker authority non-executed mutant ${mutant.mutantId} has a trace batch`);
        }
    }
    if (batchByRawMutantId.size > 0)
    {
        throw new Error('Stryker authority trace batches contain unknown inventory members');
    }
    if (canonicalJson(authority.testIdentities) !== canonicalJson(referencedTestIdentities(authority.inventory)))
    {
        throw new Error('Stryker authority test identity bindings mismatch');
    }
}

export function validateStrykerAuthority({ authority, ...inputs })
{
    validateStrykerAuthorityShape(authority);
    const recreated = createStrykerAuthority(inputs);
    if (canonicalJson(authority) !== canonicalJson(recreated))
    {
        throw new Error('Stryker authority content mismatch');
    }
    return authority;
}

function gitOutput(root, args)
{
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0)
    {
        throw new Error(`cannot resolve producer Git state: ${result.stderr.trim() || args.join(' ')}`);
    }
    return result.stdout.trim();
}

function producerIdentity(root, tierId, generatedAt)
{
    const environmentCommit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim();
    const environmentFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim();
    if (Boolean(environmentCommit) !== Boolean(environmentFingerprint))
    {
        throw new Error('scheduler producer source environment is incomplete');
    }

    let sourceState;
    if (environmentCommit && environmentFingerprint)
    {
        sourceState = requireSourceState({
            commit: environmentCommit,
            worktreeFingerprint: environmentFingerprint
        });
    }
    else
    {
        const status = gitOutput(root, ['status', '--porcelain=v1', '--untracked-files=all']);
        if (status)
        {
            throw new Error('standalone Stryker authority requires a clean Git worktree');
        }
        sourceState = requireSourceState({
            commit: gitOutput(root, ['rev-parse', 'HEAD']),
            worktreeFingerprint: sha256('{}')
        });
    }

    const environmentRunId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    const standaloneSuffix = generatedAt.replace(/[^0-9A-Za-z]/gu, '-');
    return {
        runId: environmentRunId || `${tierId}-standalone-${standaloneSuffix}-${process.pid}`,
        sourceState
    };
}

function evidencePath(root, inputPath)
{
    const absolutePath = resolve(inputPath);
    const result = relative(root, absolutePath);
    if (!result || result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result))
    {
        return absolutePath.split(sep).join('/');
    }
    return result.split(sep).join('/');
}

function parseAuthorityOptions(args)
{
    const options = {
        configPath: null,
        tierId: null,
        outputPath: null,
        sourceRoot: null,
        tracePath: null
    };
    for (let index = 0; index < args.length; index += 1)
    {
        const flag = args[index];
        const value = args[index + 1];
        if (
            !['--config', '--tier', '--out', '--source-root', '--trace-log'].includes(flag)
            || !value
            || value.startsWith('--')
        )
        {
            throw new Error(`unknown or incomplete authority option ${flag}`);
        }
        index += 1;
        if (flag === '--config')
        {
            options.configPath = value;
        }
        if (flag === '--tier')
        {
            options.tierId = value;
        }
        if (flag === '--out')
        {
            options.outputPath = value;
        }
        if (flag === '--source-root')
        {
            options.sourceRoot = value;
        }
        if (flag === '--trace-log')
        {
            options.tracePath = value;
        }
    }
    const authorityPresent = [
        options.configPath,
        options.tierId,
        options.outputPath,
        options.tracePath
    ].filter(Boolean).length;
    if (authorityPresent !== 0 && authorityPresent !== 4)
    {
        throw new Error('authority generation requires --config, --tier, --out, and --trace-log together');
    }
    if (options.sourceRoot && authorityPresent !== 4)
    {
        throw new Error('--source-root requires authority generation options');
    }
    return options;
}

function writeJsonAtomic(outputPath, value)
{
    mkdirSync(dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.next-${process.pid}`;
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 4)}\n`);
    renameSync(temporaryPath, outputPath);
}

function main()
{
    const reportPath = process.argv[2];
    if (!reportPath)
    {
        throw new Error(
            'usage: node tools/test/check-stryker-report.mjs <report.json> '
            + '[--config <config.json> --tier <tier-id> --out <authority.json> '
            + '--trace-log <verbose-log> --source-root <repository-relative-path>]'
        );
    }
    const absoluteReportPath = resolve(reportPath);
    const rawReport = readFileSync(absoluteReportPath);
    const report = JSON.parse(rawReport);
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const authorityOptions = parseAuthorityOptions(process.argv.slice(3));
    if (authorityOptions.outputPath)
    {
        const absoluteConfigPath = resolve(authorityOptions.configPath);
        const absoluteTracePath = resolve(authorityOptions.tracePath);
        const rawConfig = readFileSync(absoluteConfigPath);
        const rawTrace = readFileSync(absoluteTracePath);
        const generatedAt = new Date().toISOString();
        const producer = producerIdentity(root, authorityOptions.tierId, generatedAt);
        const inputs = {
            report,
            rawReport,
            reportPath: evidencePath(root, absoluteReportPath),
            reportAbsolutePath: absoluteReportPath,
            rawTrace,
            tracePath: evidencePath(root, absoluteTracePath),
            config: JSON.parse(rawConfig),
            rawConfig,
            configPath: evidencePath(root, absoluteConfigPath),
            tierId: authorityOptions.tierId,
            runId: producer.runId,
            sourceState: producer.sourceState,
            generatedAt,
            repositoryRoot: root,
            sourceRoot: authorityOptions.sourceRoot,
            releaseReliability: readReleaseReliabilityEvidenceBinding({
                repositoryRoot: root
            })
        };
        const authority = createStrykerAuthority(inputs);
        validateStrykerAuthority({ authority, ...inputs });
        writeJsonAtomic(resolve(authorityOptions.outputPath), authority);
        process.stdout.write(
            `[stryker-report] authority=${authorityOptions.outputPath} `
            + `run=${authority.producer.runId} score=${authority.score}\n`
        );
    }
    const summary = validateStrykerReport(report);
    process.stdout.write(
        `[stryker-report] ok executed=${summary.executedMutants} `
        + `statuses=${JSON.stringify(summary.statuses)}\n`
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (error)
    {
        process.stderr.write(
            `[stryker-report] ${error instanceof Error ? error.message : String(error)}\n`
        );
        process.exitCode = 1;
    }
}
