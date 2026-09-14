#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const fail = message =>
{
    throw new Error(`[auth-broadcast-boundaries] ${message}`);
};
const imports = source => [...source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/gu)]
    .map(match => match[1]);

const runtime = read('src/frontend/src/services/authBroadcastRuntime.ts');
const composition = read('src/frontend/src/services/authBroadcastComposition.ts');
const authSession = read('src/frontend/src/services/authSessionRuntime.ts');
const stores = [
    'src/frontend/src/store/user.ts',
    'src/frontend/src/store/admin.ts',
    'src/frontend/src/store/notificationStream.ts'
];

for (const dependency of imports(runtime))
{
    if (dependency === 'pinia' || dependency.includes('/store/') || dependency.includes('Composition'))
    {
        fail(`transport runtime imports owner dependency ${dependency}`);
    }
}
for (const token of ['useUserStore', 'useAdminStore', 'useNotificationStreamStore', 'notificationStreamRuntime'])
{
    if (runtime.includes(token))
    {
        fail(`transport runtime contains business owner ${token}`);
    }
}
for (const store of stores)
{
    const source = read(store);
    if (imports(source).some(dependency => dependency.includes('authBroadcastRuntime') || dependency.includes('authBroadcastComposition')))
    {
        fail(`${store} imports auth broadcast implementation`);
    }
}

for (const required of [
    "from './authBroadcastRuntime'",
    "from '@/store/user'",
    "from '@/store/admin'",
    "from '@/store/notificationStream'",
    'authBroadcastRuntime.subscribe(',
    'setLogoutBroadcast(',
    'setSessionRevokedHandler('
])
{
    if (!composition.includes(required))
    {
        fail(`composition missing ${required}`);
    }
}
for (const required of ['installAuthBroadcastComposition(pinia)', 'disposeAuthBroadcastComposition()'])
{
    if (!authSession.includes(required))
    {
        fail(`bootstrap lifecycle missing ${required}`);
    }
}

const eventContract = runtime.slice(
    runtime.indexOf('export type AuthBroadcastEvent ='),
    runtime.indexOf('export type AuthBroadcastEventOrigin'));
for (const type of ['login', 'logout', 'expired', 'user-expired', 'admin-changed'])
{
    if (!eventContract.includes(`type: '${type}'`))
    {
        fail(`event contract missing ${type}`);
    }
}
for (const sensitive of ['token', 'sessionId', 'accountId', 'proof', 'userId', 'adminId'])
{
    if (eventContract.includes(sensitive))
    {
        fail(`event contract exposes sensitive field ${sensitive}`);
    }
}
if (!runtime.includes('return { type: candidate.type, at: candidate.at }'))
{
    fail('received messages are not projected onto the public event contract');
}

console.log('[auth-broadcast-boundaries] transport, composition and store ownership DAG OK');
