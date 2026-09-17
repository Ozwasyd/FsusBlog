import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const clientRoot = process.cwd();

const runtimeTargets = [
    {
        file: 'src/api/index.ts',
        patterns: [
            /error\.message\.includes\(\s*['"]timeout['"]\s*\)/,
            /message\??\.includes\(\s*['"]Unauthorized['"]\s*\)/,
            /message\??\.includes\(\s*['"]401['"]\s*\)/
        ]
    },
    {
        file: 'src/workers/wasmDecode.worker.ts',
        patterns: [
            /message\.includes\(\s*['"]crc['"]\s*\)/,
            /message\.includes\(\s*['"]payload['"]\s*\)/,
            /message\.includes\(\s*['"]overflow['"]\s*\)/,
            /message\.includes\(\s*['"]range['"]\s*\)/,
            /message\.includes\(\s*['"]schema['"]\s*\)/,
            /message\.includes\(\s*['"]unsupported['"]\s*\)/,
            /message\.includes\(\s*['"]invalid['"]\s*\)/
        ]
    },
    {
        file: 'src/composables/useNotification.ts',
        patterns: [
            /failureCode === ['"]protocol_mismatch['"]/,
            /failureCode === ['"]auth_failed['"]/
        ]
    }
];

const violations = [];

for (const target of runtimeTargets)
{
    const fullPath = resolve(clientRoot, target.file);
    const source = await readFile(fullPath, 'utf8');
    for (const pattern of target.patterns)
    {
        if (pattern.test(source))
        {
            violations.push(`${target.file}: ${pattern}`);
        }
    }
}

if (violations.length > 0)
{
    console.error('runtime message branching violations:');
    for (const violation of violations)
    {
        console.error(` - ${violation}`);
    }
    process.exit(1);
}

console.log('ok: runtime logic does not branch on error message text');
