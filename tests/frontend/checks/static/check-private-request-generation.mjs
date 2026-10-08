#!/usr/bin/env node
import { auditBinaryRouteCalls, collectBinaryRouteFunctionNames } from './binary-route-call-audit.mjs';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const root = resolve(process.cwd(), '../..');
const sourceRoot = resolve(root, 'src/frontend/src');

function filesUnder(directory)
{
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? filesUnder(path) : [path];
    });
}

function fail(message)
{
    throw new Error(`[private-request-generation] ${message}`);
}

const sourceFiles = filesUnder(sourceRoot).filter(path => statSync(path).isFile() && /\.(ts|vue)$/.test(path));
const routeCallNames = new Set(sourceFiles.flatMap(path => collectBinaryRouteFunctionNames(readFileSync(path, 'utf8'))));
const generated = readFileSync(resolve(sourceRoot, 'generated/fsusBinaryRoutes.ts'), 'utf8');
const operations = new Set([...generated.matchAll(/"(binary_[^"]+)":/gu)].map(match => match[1]));
for (const path of sourceFiles)
{
    const name = relative(sourceRoot, path);
    const errors = auditBinaryRouteCalls(readFileSync(path, 'utf8'), name, operations, {
        transportOwner: name === 'services/binaryTransport.ts',
        routeCallNames
    });
    if (errors.length) fail(errors.join('\n'));
}

for (const path of filesUnder(resolve(sourceRoot, 'api')).filter(path => path.endsWith('.ts')))
{
    const source = readFileSync(path, 'utf8');
    const name = relative(root, path);
    if (name.endsWith('binaryApiClient.ts'))
    {
        continue;
    }
    if ((source.includes('fetch(') || source.includes('binaryRequest(')) && !source.includes('runPrivateRequest('))
    {
        fail(`${name} bypasses runPrivateRequest for a direct transport call`);
    }
}

const transport = readFileSync(resolve(sourceRoot, 'services/binaryTransport.ts'), 'utf8');
if (!transport.includes('privateRequestRuntime.open(resolved.scope') || !transport.includes('lease.assertCurrent()'))
{
    fail('binaryTransport must open and validate the shared generation lease');
}

const surface = readFileSync(resolve(sourceRoot, 'services/privateSurfaceRuntime.ts'), 'utf8');
if (!surface.includes('privateRequestRuntime.advanceForAuthTransition(reason)'))
{
    fail('PrivateSurfaceRuntime must advance request generations before clearing state');
}

const notification = readFileSync(resolve(sourceRoot, 'services/notificationStreamRuntime.ts'), 'utf8');
if (!notification.includes("runPrivateRequest('account', undefined, fetchPreflight)"))
{
    fail('authenticated Notification Stream preflight must share the account generation boundary');
}

console.log('[private-request-generation] all private request entry points are generation-guarded');
