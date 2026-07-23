import crypto from 'node:crypto';

export const supportedFrameworks = new Set(['xunit-trx', 'vitest', 'node-tap', 'playwright']);

function requiredText(value, label)
{
    const result = String(value ?? '').trim();
    if (!result) throw new Error(`${label} is required`);
    return result;
}

function xmlDecode(value)
{
    return String(value ?? '')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

function xmlAttributes(source)
{
    return Object.fromEntries([...String(source).matchAll(/([\w:-]+)="([^"]*)"/gu)]
        .map((match) => [match[1], xmlDecode(match[2])]));
}

function durationMilliseconds(value, label)
{
    if (typeof value === 'number')
    {
        if (!Number.isFinite(value) || value < 0) throw new Error(`${label} duration must be a finite non-negative number`);
        return value;
    }
    const text = String(value ?? '').trim();
    if (!text) return 0;
    const clock = /^(?:(\d+)\.)?(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)$/u.exec(text);
    if (clock)
    {
        return (((Number(clock[1] ?? 0) * 24 + Number(clock[2])) * 60
            + Number(clock[3])) * 60 + Number(clock[4])) * 1000;
    }
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} duration is invalid`);
    return parsed;
}

function normalizedOutcome(value, framework)
{
    const key = String(value ?? '').trim().toLowerCase();
    const maps = {
        'xunit-trx': {
            passed: 'passed', failed: 'failed', notexecuted: 'skipped',
            inconclusive: 'blocked', timeout: 'failed', aborted: 'blocked'
        },
        vitest: {
            passed: 'passed', failed: 'failed', skipped: 'skipped',
            pending: 'skipped', todo: 'skipped', disabled: 'skipped'
        },
        'node-tap': {
            passed: 'passed', failed: 'failed', skip: 'skipped', skipped: 'skipped', todo: 'blocked'
        },
        playwright: {
            passed: 'passed', failed: 'failed', skipped: 'skipped',
            timedout: 'failed', interrupted: 'blocked'
        }
    };
    const result = maps[framework]?.[key];
    if (!result) throw new Error(`${framework} outcome is unknown: ${value ?? 'missing'}`);
    return result;
}

export function normalizeFailureText(value)
{
    return String(value ?? '')
        .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
        .replaceAll('\\', '/')
        .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, '<timestamp>')
        .replace(/\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}\b/gu,
            (match) => match.replace(/:\d{2,5}$/u, ':<port>'))
        .replace(/(?:[A-Za-z]:)?\/(?:tmp|var\/tmp)\/[^\s:)\]]+/gu, (match) =>
        {
            const normalized = match.replace(/^[A-Za-z]:/u, '');
            const marker = normalized.search(/\/(?:tests?|src|tools)\//u);
            return marker >= 0 ? `<tmp>${normalized.slice(marker)}` : '<tmp>';
        })
        .replace(/(?:^|\/)(?:TestResults|test-results)\/[a-zA-Z0-9_.-]+/gu, '/test-results/<run>')
        .replace(/\b(?:run|worker|attempt)-[a-f0-9]{8,}\b/giu, (match) => `${match.split('-')[0]}-<id>`)
        .replace(/[ \t]+/gu, ' ')
        .replace(/\r\n?/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

export function failureSignature(value)
{
    const normalized = normalizeFailureText(value);
    return normalized
        ? `sha256:${crypto.createHash('sha256').update(`fsusblog.failure-signature.v1\n${normalized}`).digest('hex')}`
        : null;
}

function canonicalId(framework, parts)
{
    const normalized = parts.map((part) => requiredText(part, `${framework} test identity`)
        .replace(/\s+/gu, ' ').replaceAll('#', '%23'));
    return `${framework}:${normalized.join('#')}`;
}

export function adaptTrx(reportText)
{
    const definitions = new Map();
    for (const match of reportText.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gu))
    {
        const attributes = xmlAttributes(match[1]);
        const method = /<TestMethod\b([^>]*)\/?>/u.exec(match[2]);
        const methodAttributes = method ? xmlAttributes(method[1]) : {};
        definitions.set(attributes.id, {
            className: methodAttributes.className || 'unknown-class',
            methodName: methodAttributes.name || attributes.name || attributes.id
        });
    }
    const observations = [];
    for (const match of reportText.matchAll(/<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/gu))
    {
        const attributes = xmlAttributes(match[1]);
        const definition = definitions.get(attributes.testId) ?? {};
        const name = attributes.testName || definition.methodName;
        if (!attributes.testId || !name) throw new Error('TRX result is missing testId or testName');
        const body = match[2] ?? '';
        const message = /<Message>([\s\S]*?)<\/Message>/u.exec(body)?.[1] ?? '';
        const stack = /<StackTrace>([\s\S]*?)<\/StackTrace>/u.exec(body)?.[1] ?? '';
        observations.push({
            testId: canonicalId('xunit-trx', [definition.className ?? attributes.testId, name]),
            suite: definition.className ?? 'xunit',
            outcome: normalizedOutcome(attributes.outcome, 'xunit-trx'),
            durationMs: durationMilliseconds(attributes.duration, name),
            failure: xmlDecode(`${message}\n${stack}`).trim()
        });
    }
    if (observations.length === 0) throw new Error('TRX report contains no UnitTestResult records');
    return observations;
}

export function adaptVitest(report)
{
    const files = report.testResults ?? report.files;
    if (!Array.isArray(files)) throw new Error('Vitest report must contain testResults or files');
    const observations = [];
    for (const file of files)
    {
        const fileName = file.name ?? file.filepath ?? file.file ?? file.testModule?.moduleId;
        const assertions = file.assertionResults ?? file.tasks ?? file.tests;
        if (!fileName || !Array.isArray(assertions)) throw new Error('Vitest file is missing name or assertions');
        for (const assertion of assertions)
        {
            const title = assertion.title ?? assertion.name;
            const ancestors = assertion.ancestorTitles ?? assertion.suite ?? [];
            if (!title) throw new Error(`Vitest assertion in ${fileName} is missing a title`);
            const pathParts = [...(Array.isArray(ancestors) ? ancestors : [ancestors]), title];
            observations.push({
                testId: canonicalId('vitest', [fileName, pathParts.join(' > ')]),
                suite: pathParts.slice(0, -1).join(' > ') || fileName,
                outcome: normalizedOutcome(assertion.status ?? assertion.result?.state, 'vitest'),
                durationMs: durationMilliseconds(assertion.duration ?? assertion.result?.duration ?? 0, title),
                failure: (assertion.failureMessages ?? assertion.errors ?? [])
                    .map((entry) => typeof entry === 'string' ? entry : entry?.message ?? JSON.stringify(entry))
                    .join('\n')
            });
        }
    }
    if (observations.length === 0) throw new Error('Vitest report contains no assertions');
    return observations;
}

export function adaptNodeTap(reportText, { suite = 'node-tap' } = {})
{
    const observations = [];
    for (const line of String(reportText).split(/\r?\n/u))
    {
        const result = /^\s*(not )?ok(?:\s+\d+)?(?:\s*-\s*)?(.+?)\s*$/u.exec(line);
        if (result)
        {
            const directive = /#\s*(skip|todo)\b(?:\s*-\s*)?(.*)$/iu.exec(result[2]);
            const name = result[2].replace(/\s+#\s*(?:skip|todo)\b.*$/iu, '').trim();
            if (!name) throw new Error('TAP assertion is missing a test name');
            observations.push({
                testId: canonicalId('node-tap', [suite, name]),
                suite,
                outcome: directive
                    ? normalizedOutcome(directive[1], 'node-tap')
                    : normalizedOutcome(result[1] ? 'failed' : 'passed', 'node-tap'),
                durationMs: 0,
                failure: result[1] ? `TAP assertion failed: ${name}` : ''
            });
            continue;
        }
        const duration = /^\s*#\s*duration_ms\s+(\d+(?:\.\d+)?)\s*$/iu.exec(line);
        if (duration && observations.length > 0)
        {
            observations.at(-1).durationMs = durationMilliseconds(duration[1], observations.at(-1).testId);
            continue;
        }
        const diagnostic = /^\s+(?:error|message|stack):\s*(.+)$/iu.exec(line);
        if (diagnostic && observations.at(-1)?.outcome === 'failed')
        {
            observations.at(-1).failure += `\n${diagnostic[1]}`;
        }
    }
    if (observations.length === 0) throw new Error('TAP report contains no assertions');
    return observations;
}

export function adaptPlaywright(report)
{
    if (!Array.isArray(report.suites)) throw new Error('Playwright report must contain suites');
    const observations = [];
    const visit = (suite, parents = []) =>
    {
        const titles = suite.title ? [...parents, suite.title] : parents;
        for (const spec of suite.specs ?? [])
        {
            const identity = [
                spec.file ?? suite.file ?? 'unknown-file',
                `${spec.line ?? 0}:${spec.column ?? 0}`,
                [...titles, spec.title].filter(Boolean).join(' > ')
            ];
            for (const test of spec.tests ?? [])
            {
                const results = test.results ?? [];
                if (results.length === 0) throw new Error(`Playwright test ${spec.title} has no results`);
                for (const [attempt, result] of results.entries())
                {
                    const error = result.error ?? result.errors?.[0] ?? {};
                    observations.push({
                        testId: canonicalId('playwright', identity),
                        suite: titles.join(' > ') || spec.file || 'playwright',
                        partition: test.projectName ?? test.projectId ?? null,
                        attempt,
                        outcome: normalizedOutcome(result.status, 'playwright'),
                        durationMs: durationMilliseconds(result.duration ?? 0, spec.title),
                        failure: [error.name, error.message, error.stack].filter(Boolean).join('\n')
                    });
                }
            }
        }
        for (const child of suite.suites ?? []) visit(child, titles);
    };
    for (const suite of report.suites) visit(suite);
    if (observations.length === 0) throw new Error('Playwright report contains no test results');
    return observations;
}

export function adaptReport({ framework, reportText, suite, report })
{
    if (!supportedFrameworks.has(framework)) throw new Error(`unsupported test observation framework: ${framework}`);
    if (framework === 'xunit-trx') return adaptTrx(reportText);
    if (framework === 'node-tap') return adaptNodeTap(reportText, { suite });
    const parsed = report ?? JSON.parse(reportText);
    return framework === 'vitest' ? adaptVitest(parsed) : adaptPlaywright(parsed);
}
