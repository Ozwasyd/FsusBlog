import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const clientRoot = process.cwd();
const repoRoot = resolve(clientRoot, '..', '..');

const tsEnumPath = resolve(clientRoot, 'src/utils/appError.ts');
const csharpEnumPath = resolve(repoRoot, 'src/core/Common/ErrorCode.cs');
const resultBoundaryPath = resolve(repoRoot, 'tests/frontend/checks/static/check-result-boundaries.mjs');

// Fact authority for public error codes lives in the config-error-security-policy
// observation / fact extractor. This checker only enforces structural hygiene and
// that the frontend consumer catalog covers every production ErrorCode by name —
// without maintaining a second handwritten alignment table.

const bannedPatterns = [
    {
        file: resolve(clientRoot, 'src/store/user.ts'),
        patterns: [
            /message\s*===\s*['"]Unauthorized['"]/,
            /message\??\.includes\(\s*['"]Unauthorized['"]\s*\)/,
            /message\??\.includes\(\s*['"]401['"]\s*\)/
        ]
    },
    {
        file: resolve(clientRoot, 'src/services/authSessionRuntime.ts'),
        patterns: [
            /message\s*===\s*['"]Unauthorized['"]/,
            /message\??\.includes\(\s*['"]Unauthorized['"]\s*\)/,
            /message\??\.includes\(\s*['"]401['"]\s*\)/
        ]
    },
    {
        file: resolve(clientRoot, 'src/services/notificationStreamRuntime.ts'),
        patterns: [
            /message\s*===\s*['"]protocol_mismatch['"]/
        ]
    },
    {
        file: resolve(clientRoot, 'src/services/binaryTransport.ts'),
        patterns: [
            /message\??\.includes\(\s*['"]disabled['"]\s*\)/,
            /message\??\.includes\(\s*['"]decode['"]\s*\)/,
            /message\??\.includes\(\s*['"]frame['"]\s*\)/,
            /message\??\.includes\(\s*['"]schema['"]\s*\)/
        ]
    },
    {
        file: resolve(clientRoot, 'src/composables/useAuthLogin.ts'),
        patterns: [
            /normalized\.message\.includes\(\s*['"]POW_CALCULATION_TIMEOUT['"]\s*\)/
        ]
    }
];

function parseEnumMembers(source)
{
    const enumMembers = [...source.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=/gm)].map((match) => match[1]);
    const constObjectMembers = [...source.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*['"][^'"]+['"],?/gm)].map((match) => match[1]);
    return [...new Set([...enumMembers, ...constObjectMembers])];
}

const tsEnumSource = await readFile(tsEnumPath, 'utf8');
const csharpEnumSource = await readFile(csharpEnumPath, 'utf8');
const tsEnumMembers = new Set(parseEnumMembers(tsEnumSource));
const csharpEnumMembers = parseEnumMembers(csharpEnumSource).filter((name) => name !== 'None');

const violations = [];

for (const csharpName of csharpEnumMembers)
{
    if (!tsEnumMembers.has(csharpName))
    {
        violations.push(`frontend AppErrorCode missing production ErrorCode ${csharpName}`);
    }
}

for (const target of bannedPatterns)
{
    const source = await readFile(target.file, 'utf8');
    for (const pattern of target.patterns)
    {
        if (pattern.test(source))
        {
            violations.push(`string-based error branching remains in ${target.file.replace(`${clientRoot}/`, '')}: ${pattern}`);
        }
    }
}

const resultBoundarySource = await readFile(resultBoundaryPath, 'utf8');
const allowListMatch = resultBoundarySource.match(/const allowList = new Set\(\[(?<body>[\s\S]*?)\]\)/);
if (!allowListMatch?.groups?.body)
{
    violations.push('unable to parse final allowList from check-result-boundaries.mjs');
}
else
{
    const allowEntries = [...allowListMatch.groups.body.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
    const expectedAllowEntries = [
        'src/bootstrap/fullApp.ts',
        'src/public-renderers/hydrationIdentityGuard.ts'
    ].sort();

    if (allowEntries.join('\0') !== expectedAllowEntries.join('\0'))
    {
        violations.push(`unexpected result-boundary allowList: ${allowEntries.join(', ')}`);
    }
}

try
{
    await readFile(resolve(clientRoot, 'src/services/notificationService.ts'), 'utf8');
    violations.push('legacy runtime alias src/services/notificationService.ts must be removed');
}
catch
{
    // expected: compat alias removed in stage 5
}

if (violations.length > 0)
{
    console.error('error-code alignment violations:');
    for (const violation of violations)
    {
        console.error(` - ${violation}`);
    }
    process.exit(1);
}

console.log('ok: frontend AppErrorCode covers production ErrorCode catalog; string-branch hygiene holds');
