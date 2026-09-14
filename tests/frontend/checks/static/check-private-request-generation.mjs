#!/usr/bin/env node

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
for (const path of sourceFiles)
{
    const source = readFileSync(path, 'utf8');
    const name = relative(root, path);
    if (name.endsWith('services/binaryTransport.ts'))
    {
        continue;
    }
    const legacyRequests = [...source.matchAll(/binaryUrl\s*:(?!\s*string\b)\s*[^,\n]+,/g)];
    for (const request of legacyRequests)
    {
        const tail = source.slice(request.index + request[0].length, request.index + request[0].length + 160);
        if (!/privateScope\s*:\s*'(public|account|admin)'/.test(tail))
        {
            fail(`${name} has a legacy binaryUrl without an explicit privateScope`);
        }
    }
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
if (!transport.includes('privateRequestRuntime.open(resolved.privateScope') || !transport.includes('lease.assertCurrent()'))
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
