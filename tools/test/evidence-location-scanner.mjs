#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const supportedExtension = /\.(?:cs|js|json|mjs|sh|ts|tsx|ya?ml)$/u;
// These files define the scanner authority itself. Scanning their rule text or
// generated inventory would recursively create findings about the governance
// contract instead of repository consumers. The list is deliberately exact:
// wildcard or directory suppressions are not supported.
const authoritySourcePaths = new Set([
    'artifacts/change-contract/evidence-location-governance-post-merge-repair.json',
    'config/testing/current-run-evidence-context.schema.json',
    'config/testing/current-run-evidence-location-acceptance.json',
    'config/testing/evidence-location-migration-ledger.json',
    'config/testing/evidence-location-migration-ledger.schema.json',
    'config/testing/evidence-locator-registry.json',
    'config/testing/evidence-locator-registry.schema.json',
    'tools/test/evidence-location-contract.mjs',
    'tools/test/evidence-location-scanner.mjs',
    'tools/test/generate-evidence-location-governance.mjs',
    'tools/test/current-run-evidence-locator.mjs',
    'tools/test/current-run-evidence-transport.mjs',
    'tools/test/run-current-run-evidence-transport.mjs',
    'tools/test/generate-current-run-evidence-location-acceptance.mjs'
]);
const evidenceVocabulary = /(?:artifact|checkpoint|coverage|evidence|flaky|manifest|public[-_ ]preview|quality[-_ ]gate|receipt|release[-_ ]final|report|summary)/iu;
const stableFunction = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u;

export const EVIDENCE_LOCATION_SCAN_SCHEMA = 'fsusblog.evidence-location-scan.v1';

export const evidenceLocationRules = Object.freeze([
    {
        id: 'evidence-selection.mtime-ctime',
        description: 'filesystem mtime ctime or birthtime participates in candidate selection',
        pattern: /\b(?:birthtime|ctime|mtime)(?:Ms|Ns)?\b/iu
    },
    {
        id: 'evidence-selection.timestamp-sort',
        description: 'timestamp ordering selects an evidence candidate',
        pattern: /\.sort\s*\([^\n]*(?:createdAt|generatedAt|timestamp|updatedAt|timeMs)/iu
    },
    {
        id: 'evidence-selection.latest-newest',
        description: 'latest or newest naming selects mutable evidence',
        pattern: /\b(?:latest|newest)(?:[A-Z_][A-Za-z0-9_]*)?\b|(?:latest|current)[-_.][A-Za-z0-9_.-]*\.json/iu
    },
    {
        id: 'evidence-selection.directory-scan',
        description: 'directory glob or recursive file enumeration discovers evidence candidates',
        pattern: /\b(?:findFiles|globSync|glob|listJsonFiles|readdir|readdirSync|walkJsonFiles)\s*\(/u
    },
    {
        id: 'evidence-selection.schema-search',
        description: 'schema-driven helper searches candidate receipts rather than consuming a bound location',
        pattern: /\b(?:findReceiptFile|findSchemaReceipt|locateReceiptBySchema)\s*\(/u
    },
    {
        id: 'evidence-selection.first-match',
        description: 'first array or find match chooses an evidence candidate',
        pattern: /\b(?:artifacts?|candidates?|checkpoints?|documents?|evidence|files?|manifests?|matches?|receipts?|reports?|roots?|summaries?)\b[^\n]{0,96}(?:\[[\t ]*0[\t ]*\]|\.at\([\t ]*0[\t ]*\)|\.find\s*\()/iu
    },
    {
        id: 'evidence-selection.downloaded-artifacts-scan',
        description: 'downloaded artifacts are used as a broad candidate source',
        pattern: /\.tmp[\\/]downloaded-artifacts|\.tmp\/downloaded-artifacts/u
    },
    {
        id: 'evidence-selection.fallback-candidates',
        description: 'preferred local and fallback candidates are combined for selection',
        pattern: /\b(?:candidate|preferred|fallback)(?:Files|Paths|Roots|Candidates)\b[^\n]*(?:\.\.\.|\?|\[)|\[\s*(?:environment|process\.env)\.[A-Za-z0-9_]+[^\n]*,\s*['"][^'"]*(?:artifact|evidence|receipt)/iu
    },
    {
        id: 'evidence-selection.pointer-without-identity',
        description: 'mutable current or latest pointer is read without explicit identity in the same statement',
        pattern: /(?:current|latest)[-_.][A-Za-z0-9_.-]*\.json/iu,
        rejectWhen: /(?:attemptId|contentDigest|runId|sourceCommit|worktreeFingerprint)/u
    },
    {
        id: 'evidence-selection.explicit-mismatch-fallback',
        description: 'an explicit candidate mismatch continues to a fallback search',
        pattern: /(?:mismatch|schema\s*!==|commit\s*!==)[^\n]*(?:continue|fallback|search)/iu
    },
    {
        id: 'evidence-selection.local-downloaded-priority',
        description: 'local and downloaded evidence roots form an ordered priority set',
        pattern: /(?:(?:\.tmp[\\/]release-evidence|releaseEvidenceDir)[\s\S]{0,800}(?:\.tmp[\\/]downloaded-artifacts|downloadedArtifactsDir)|(?:\.tmp[\\/]downloaded-artifacts|downloadedArtifactsDir)[\s\S]{0,800}(?:\.tmp[\\/]release-evidence|releaseEvidenceDir))/iu,
        windowLines: 8
    }
]);

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, canonicalize(value[key])]));
}

export function evidenceLocationDigest(value)
{
    return `sha256:${crypto.createHash('sha256')
        .update(JSON.stringify(canonicalize(value))).digest('hex')}`;
}

function trackedFiles(root)
{
    const result = spawnSync('git', ['ls-files', '-z'], {
        cwd: root,
        encoding: 'utf8'
    });
    if (result.status !== 0)
    {
        throw new Error(`cannot enumerate tracked repository files: ${result.stderr.trim()}`);
    }
    return result.stdout.split('\0').filter(Boolean);
}

function isScanSurface(file)
{
    if (!supportedExtension.test(file) || authoritySourcePaths.has(file))
    {
        return false;
    }
    if (!file.startsWith('tests/'))
    {
        return true;
    }
    return file.startsWith('tests/browser-contract/')
        || file.startsWith('tests/browser-diagnostics/')
        || file.startsWith('tests/frontend/e2e/');
}

function functionByLine(lines)
{
    const owners = [];
    let current = '<module>';
    let depth = 0;
    for (const line of lines)
    {
        const match = line.match(stableFunction);
        if (match)
        {
            current = match[1] ?? match[2];
            depth = 0;
        }
        owners.push(current);
        if (current !== '<module>')
        {
            depth += (line.match(/\{/gu) ?? []).length;
            depth -= (line.match(/\}/gu) ?? []).length;
            if (depth <= 0 && line.includes('}'))
            {
                current = '<module>';
                depth = 0;
            }
        }
    }
    return owners;
}

function evidenceRelevant(file, line, functionName, rule)
{
    if (evidenceVocabulary.test(line) || evidenceVocabulary.test(functionName))
    {
        return true;
    }
    if (['evidence-selection.directory-scan', 'evidence-selection.downloaded-artifacts-scan',
        'evidence-selection.mtime-ctime', 'evidence-selection.pointer-without-identity',
        'evidence-selection.local-downloaded-priority'].includes(rule.id))
    {
        return evidenceVocabulary.test(file);
    }
    return file.startsWith('tools/') && evidenceVocabulary.test(file);
}

function findingId(finding)
{
    return evidenceLocationDigest({
        file: finding.file,
        function: finding.function,
        line: finding.line,
        ruleId: finding.ruleId
    }).slice(7, 23);
}

function scanFile(root, file)
{
    const absolute = path.join(root, file);
    if (!supportedExtension.test(file) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
    {
        return [];
    }
    const text = fs.readFileSync(absolute, 'utf8');
    const lines = text.split(/\r?\n/u);
    const functions = functionByLine(lines);
    const findings = [];
    for (let index = 0; index < lines.length; index += 1)
    {
        const line = lines[index];
        for (const rule of evidenceLocationRules)
        {
            if (!evidenceRelevant(file, line, functions[index], rule))
            {
                continue;
            }
            const candidate = rule.windowLines
                ? lines.slice(index, index + rule.windowLines).join('\n')
                : line;
            const match = candidate.match(rule.pattern);
            if (!match
                || (rule.windowLines && (match.index ?? 0) >= line.length)
                || (rule.rejectWhen && rule.rejectWhen.test(line)))
            {
                continue;
            }
            const finding = {
                findingId: '',
                ruleId: rule.id,
                file,
                line: index + 1,
                column: (match.index ?? 0) < line.length ? (match.index ?? 0) + 1 : 1,
                function: functions[index],
                excerpt: line.trim().slice(0, 240),
                indirectVia: null
            };
            finding.findingId = findingId(finding);
            findings.push(finding);
        }
    }
    return findings;
}

function propagateHelperCalls(root, files, directFindings)
{
    const helpersByName = new Map();
    for (const finding of directFindings)
    {
        if (finding.file.startsWith('tools/')
            && finding.function !== '<module>'
            && /(?:artifact|evidence|files|flaky|json|latest|manifest|receipt|report|roots|summary)/iu.test(finding.function))
        {
            const key = `${finding.file}:${finding.function}`;
            const helpers = helpersByName.get(finding.function) ?? new Map();
            const rules = helpers.get(key) ?? new Set();
            rules.add(finding.ruleId);
            helpers.set(key, rules);
            helpersByName.set(finding.function, helpers);
        }
    }
    const derived = [];
    for (const file of files)
    {
        if (!supportedExtension.test(file))
        {
            continue;
        }
        const absolute = path.join(root, file);
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
        {
            continue;
        }
        const text = fs.readFileSync(absolute, 'utf8');
        if (!evidenceVocabulary.test(file) && !evidenceVocabulary.test(text))
        {
            continue;
        }
        const lines = text.split(/\r?\n/u);
        const functions = functionByLine(lines);
        for (let index = 0; index < lines.length; index += 1)
        {
            const calls = lines[index].matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu);
            for (const match of calls)
            {
                const helperName = match[1];
                const helpers = helpersByName.get(helperName);
                if (!helpers)
                {
                    continue;
                }
                for (const [helperKey, rules] of helpers)
                {
                    const separator = helperKey.lastIndexOf(':');
                    const helperFile = helperKey.slice(0, separator);
                    if (file !== helperFile || functions[index] === helperName)
                    {
                        continue;
                    }
                    const finding = {
                        findingId: '',
                        ruleId: 'evidence-selection.indirect-helper-call',
                        file,
                        line: index + 1,
                        column: (match.index ?? 0) + 1,
                        function: functions[index],
                        excerpt: lines[index].trim().slice(0, 240),
                        indirectVia: `${helperFile}:${helperName}:${[...rules].sort().join(',')}`
                    };
                    finding.findingId = findingId(finding);
                    derived.push(finding);
                }
            }
        }
    }
    return derived;
}

export function scanEvidenceLocations({ root = repositoryRoot, files = null } = {})
{
    const selectedFiles = (files ?? trackedFiles(root)).filter(isScanSurface);
    const direct = selectedFiles.flatMap((file) => scanFile(root, file));
    const indirect = propagateHelperCalls(root, selectedFiles, direct);
    const unique = new Map();
    for (const finding of [...direct, ...indirect])
    {
        unique.set(`${finding.ruleId}:${finding.file}:${finding.line}:${finding.indirectVia ?? ''}`, finding);
    }
    const findings = [...unique.values()].sort((left, right) =>
        left.file.localeCompare(right.file)
        || left.line - right.line
        || left.ruleId.localeCompare(right.ruleId)
        || String(left.indirectVia).localeCompare(String(right.indirectVia)));
    const payload = {
        schema: EVIDENCE_LOCATION_SCAN_SCHEMA,
        rules: evidenceLocationRules.map(({ id, description }) => ({ id, description })),
        findings
    };
    return Object.freeze({
        ...payload,
        contentDigest: evidenceLocationDigest(payload)
    });
}

function main()
{
    const scan = scanEvidenceLocations();
    if (process.argv.includes('--json'))
    {
        process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
        return;
    }
    for (const finding of scan.findings)
    {
        process.stdout.write(`${finding.findingId}\t${finding.ruleId}\t${finding.file}:${finding.line}\t${finding.function}\n`);
    }
    process.stdout.write(`[evidence-location-scan] findings=${scan.findings.length} digest=${scan.contentDigest}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main();
}
