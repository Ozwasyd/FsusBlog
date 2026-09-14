#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rootArgIndex = process.argv.indexOf('--root');
const repoRoot = rootArgIndex >= 0 && process.argv[rootArgIndex + 1]
    ? resolve(process.argv[rootArgIndex + 1])
    : scriptRoot;
const errors = [];
const sources = new Map();

function walk(directory)
{
    if (!existsSync(directory))
    {
        return;
    }
    for (const entry of readdirSync(directory))
    {
        const fullPath = join(directory, entry);
        const info = statSync(fullPath);
        if (info.isDirectory())
        {
            walk(fullPath);
        }
        else if (entry.endsWith('.cs'))
        {
            const label = relative(repoRoot, fullPath).replaceAll('\\', '/');
            sources.set(label, readFileSync(fullPath, 'utf8'));
        }
    }
}

walk(resolve(repoRoot, 'src/backend'));
walk(resolve(repoRoot, 'src/shared'));

function lineOf(source, index)
{
    return source.slice(0, index).split('\n').length;
}

function report(file, source, index, message)
{
    errors.push(`${file}:${lineOf(source, Math.max(0, index))}:${message}`);
}

function escapeRegExp(value)
{
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractDeclaration(source, typeName)
{
    const pattern = new RegExp(`\\b(?:record\\s+(?:(?:class|struct)\\s+)?|class\\s+|struct\\s+|enum\\s+)${escapeRegExp(typeName)}\\b`, 'u');
    const match = pattern.exec(source);
    if (!match)
    {
        return null;
    }

    const start = match.index;
    const openBrace = source.indexOf('{', start);
    const semicolon = source.indexOf(';', start);
    if (semicolon >= 0 && (openBrace < 0 || semicolon < openBrace))
    {
        return { start, text: source.slice(start, semicolon + 1) };
    }
    if (openBrace < 0)
    {
        return { start, text: source.slice(start) };
    }

    let depth = 0;
    for (let index = openBrace; index < source.length; index += 1)
    {
        if (source[index] === '{')
        {
            depth += 1;
        }
        if (source[index] === '}')
        {
            depth -= 1;
            if (depth === 0)
            {
                return { start, text: source.slice(start, index + 1) };
            }
        }
    }
    return { start, text: source.slice(start) };
}

const declarations = new Map();
const declarationPattern = /\b(?:record\s+(?:(?:class|struct)\s+)?|class\s+|struct\s+|enum\s+)([A-Za-z_][A-Za-z0-9_]*)\b/gu;
for (const [file, source] of sources)
{
    for (const match of source.matchAll(declarationPattern))
    {
        if (!declarations.has(match[1]))
        {
            const declaration = extractDeclaration(source, match[1]);
            if (declaration)
            {
                declarations.set(match[1], { file, source, ...declaration });
            }
        }
    }
}

const channelTypes = new Set();
const channelPattern = /\bChannel(?:Reader|Writer)?\s*<\s*([A-Za-z_][A-Za-z0-9_.]*)\s*>/gu;
for (const source of sources.values())
{
    for (const match of source.matchAll(channelPattern))
    {
        channelTypes.add(match[1].split('.').at(-1));
    }
}

const scalarTypes = new Set(['byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'bool', 'char', 'string']);
const forbiddenNetworkTypes = /\b(?:System\.Net\.)?(?:IPAddress|IPEndPoint|EndPoint)\b|\b(?:HttpContext|ConnectionInfo|IHeaderDictionary)\b/gu;
const safeIdentityForm = /Ip(?:Hash|Pseudonym)/iu;

function isRawNetworkIdentifier(token)
{
    if (safeIdentityForm.test(token))
    {
        return false;
    }
    const compact = token.replaceAll('_', '').toLowerCase();
    if ([
        'ip',
        'clientip',
        'remoteip',
        'remoteipaddress',
        'ipaddress',
        'rawip',
        'rawipaddress',
        'forwardedfor',
        'xforwardedfor',
        'xrealip',
        'networkaddress',
        'clientaddress'
    ].includes(compact))
    {
        return true;
    }

    return /(?:^|_)(?:raw|remote|client|source|network)?ip(?:address)?(?:$|_)/iu.test(token)
    || /(?:Raw|Remote|Client|Source|Network)?Ip(?:Address)?(?:$|[A-Z_])/u.test(token);
}

const visitedTypes = new Set();
function inspectContract(typeName, rootType)
{
    if (visitedTypes.has(typeName) || scalarTypes.has(typeName))
    {
        return;
    }
    visitedTypes.add(typeName);
    const declaration = declarations.get(typeName);
    if (!declaration)
    {
        return;
    }

    const typeMatch = forbiddenNetworkTypes.exec(declaration.text);
    forbiddenNetworkTypes.lastIndex = 0;
    if (typeMatch)
    {
        report(
            declaration.file,
            declaration.source,
            declaration.start + typeMatch.index,
            `async contract ${rootType} reaches raw network type ${typeMatch[0]}`
        );
    }

    const tokens = declaration.text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/gu);
    for (const tokenMatch of tokens)
    {
        const token = tokenMatch[0];
        if (isRawNetworkIdentifier(token))
        {
            report(
                declaration.file,
                declaration.source,
                declaration.start + tokenMatch.index,
                `async contract ${rootType} contains raw network identifier ${token}`
            );
        }
    }

    const referencedTypes = new Set();
    for (const match of declaration.text.matchAll(/\b([A-Z][A-Za-z0-9_]*)\??(?:\[\])?\s+[A-Za-z_][A-Za-z0-9_]*\s*(?=[,);{=]|=>)/gu))
    {
        referencedTypes.add(match[1]);
    }
    for (const match of declaration.text.matchAll(/<\s*([A-Z][A-Za-z0-9_]*)\s*>/gu))
    {
        referencedTypes.add(match[1]);
    }
    for (const referencedType of referencedTypes)
    {
        if (referencedType !== typeName && declarations.has(referencedType))
        {
            inspectContract(referencedType, rootType);
        }
    }
}

for (const typeName of channelTypes)
{
    inspectContract(typeName, typeName);
}

const rawAsyncSink = /(?:TryWrite|WriteAsync)\s*\([\s\S]{0,400}?(?:GetClientIp\s*\(|RemoteIpAddress|X-Forwarded-For|X-Real-IP)/gu;
for (const [file, source] of sources)
{
    for (const match of source.matchAll(rawAsyncSink))
    {
        report(file, source, match.index, 'raw request network identity flows into an async writer');
    }
}

const visitLogPath = 'src/backend/Services/VisitLog/VisitLogProcessorService.cs';
const humanReadPath = 'src/backend/Services/HumanReadProofService.cs';
if (sources.has(visitLogPath) || sources.has(humanReadPath))
{
    const visitSource = sources.get(visitLogPath) ?? '';
    const visitContract = extractDeclaration(visitSource, 'VisitLogMessage')?.text ?? '';
    const expectedVisitFields = ['AggregateHourUtc', 'EventType', 'ArticleId', 'DwellBucket'];
    for (const field of expectedVisitFields)
    {
        if (!new RegExp(`\\b${field}\\b`, 'u').test(visitContract))
        {
            errors.push(`${visitLogPath}:1:VisitLogMessage missing coarse field ${field}`);
        }
    }
    const constructorMatch = visitContract.match(/VisitLogMessage\s*\(([\s\S]*?)\)\s*;/u);
    const actualVisitFields = constructorMatch
        ? constructorMatch[1]
      .split(',')
      .map((parameter) => parameter.trim().match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/u)?.[1])
      .filter(Boolean)
        : [];
    if (actualVisitFields.join('|') !== expectedVisitFields.join('|'))
    {
        errors.push(`${visitLogPath}:1:VisitLogMessage fields must be exactly ${expectedVisitFields.join(', ')}`);
    }
    for (const token of ['Region', 'Route', 'Viewer', 'Proof', 'Device', 'UserAgent', 'DwellMs'])
    {
        if (new RegExp(`\\b[A-Za-z0-9_]*${token}[A-Za-z0-9_]*\\b`, 'iu').test(visitContract))
        {
            errors.push(`${visitLogPath}:1:VisitLogMessage contains forbidden request-level field ${token}`);
        }
    }

    const humanReadSource = sources.get(humanReadPath) ?? '';
    const getClientIpCount = (humanReadSource.match(/\.GetClientIp\s*\(/gu) ?? []).length;
    if (getClientIpCount !== 1)
    {
        errors.push(`${humanReadPath}:1:raw IP must have exactly one synchronous HMAC use; found ${getClientIpCount}`);
    }
    for (const marker of [
        'BuildScopedDedupToken',
        's_dedupEpochDuration = TimeSpan.FromMinutes(15)',
        's_dedupLeaseTtl = s_dedupEpochDuration + s_challengeTtl',
        'new VisitLogMessage(',
        'ReadDwellBuckets.Classify'
    ])
    {
        if (!humanReadSource.includes(marker))
        {
            errors.push(`${humanReadPath}:1:missing read ingress privacy marker ${marker}`);
        }
    }
    for (const forbidden of ['RemoteIpAddress', 'X-Forwarded-For', 'X-Real-IP'])
    {
        const index = humanReadSource.indexOf(forbidden);
        if (index >= 0)
        {
            report(humanReadPath, humanReadSource, index, `read analytics must not inspect ${forbidden}`);
        }
    }

    const forbiddenReadSink = /(?:logger\.[A-Za-z]+|SetTag|SetBaggage|Exception\.Data|File\.[A-Za-z]+|Record[A-Za-z]*)\s*\([\s\S]{0,500}?\.GetClientIp\s*\(/gu;
    for (const match of humanReadSource.matchAll(forbiddenReadSink))
    {
        report(humanReadPath, humanReadSource, match.index, 'raw IP flows into a log, trace, metric, exception, or file sink');
    }

    const readIngressPath = 'src/backend/Infrastructure/Security/ReadProofIngressPrivacy.cs';
    const readIngressSource = sources.get(readIngressPath) ?? '';
    for (const marker of [
        's_partitionEpochDuration = TimeSpan.FromMinutes(1)',
        'fsus-human-read/rate-limit-key/v1',
        'fsus-human-read/rate-limit-partition/v1',
        'HMACSHA256.HashData',
        'digest.AsSpan(0, 16)'
    ])
    {
        if (!readIngressSource.includes(marker))
        {
            errors.push(`${readIngressPath}:1:missing rate-limit minimization marker ${marker}`);
        }
    }

    const rateLimitPath = 'src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs';
    const rateLimitSource = sources.get(rateLimitPath) ?? '';
    const policyStart = rateLimitSource.indexOf('options.AddPolicy("read_proof"');
    const policyEnd = policyStart >= 0 ? rateLimitSource.indexOf('options.AddPolicy(', policyStart + 20) : -1;
    const readPolicy = policyStart >= 0
        ? rateLimitSource.slice(policyStart, policyEnd >= 0 ? policyEnd : rateLimitSource.length)
        : '';
    if (!readPolicy.includes('IReadProofRateLimitPartitioner'))
    {
        errors.push(`${rateLimitPath}:1:read_proof limiter must use the minimized partitioner`);
    }
    if (/read-proof:\$?\{?clientIp/iu.test(readPolicy))
    {
        errors.push(`${rateLimitPath}:1:read_proof limiter must not retain raw clientIp in its partition key`);
    }

    const readPipelineFiles = [
        humanReadPath,
        visitLogPath,
        readIngressPath,
        'src/backend/Infrastructure/Auth/HumanReadProofEndpointAdapter.cs',
        'src/backend/Infrastructure/Middlewares/VisitLogMiddleware.cs',
        'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.ReadProof.cs'
    ];
    const directRawSink = /(?:logger\.[A-Za-z]+|SetTag|SetBaggage|Exception\.Data|File\.[A-Za-z]+|FsusObservability\.[A-Za-z]+)\s*\([\s\S]{0,500}?(?:GetClientIp\s*\(|RemoteIpAddress|X-Forwarded-For|X-Real-IP)/gu;
    for (const file of readPipelineFiles)
    {
        const source = sources.get(file) ?? '';
        for (const match of source.matchAll(directRawSink))
        {
            report(file, source, match.index, 'read pipeline raw identity flows into telemetry, exception data, or fallback storage');
        }
    }
}

if (errors.length > 0)
{
    console.error('[check-async-telemetry-privacy] failed');
    for (const error of [...new Set(errors)].sort())
    {
        console.error(`- ${error}`);
    }
    process.exit(1);
}

console.log(`[check-async-telemetry-privacy] ok channelContracts=${channelTypes.size} reachableTypes=${visitedTypes.size}`);
