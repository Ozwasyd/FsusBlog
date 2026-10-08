import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = 'src/article-vault/macos';
const managedSources = [
    'FSEventsNative.cs',
    'MacVaultRawFactBuffer.cs',
    'MacVaultRawFactCodec.cs',
    'MacVaultObservationAdapter.cs',
    'MacVaultRootPathScope.cs',
    'MacVaultWatchContracts.cs',
    'MacVaultWatcherSession.cs',
];

// Strip comments, keeping strings for fixed-path checks. This is a narrow source obligation,
// not a C compiler, behavioral qualification or replacement for the native test category.
function StripComments(source) {
    return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu,
        (match) => match.startsWith('//') || match.startsWith('/*') ? ' ' : match);
}

function Body(source, name) {
    const marker = new RegExp(`\\b${name}\\s*\\([^;{}]*\\)\\s*\\{`, 'u');
    const match = marker.exec(source);
    if (!match) {
        return null;
    }
    let depth = 1;
    const start = match.index + match[0].length;
    for (let index = start; index < source.length; index++) {
        if (source[index] === '{') {
            depth++;
        } else if (source[index] === '}' && --depth === 0) {
            return source.slice(start, index);
        }
    }
    return null;
}

export function AuditMacVaultObserver(nativeSource, managed) {
    const violations = [];
    const native = StripComments(nativeSource);
    const source = Object.values(managed).map(StripComments).join('\n');
    const manifest = Body(native, 'FsusVaultMacReadManifest');
    const teardown = Body(native, 'FsusVaultMacClose');
    const start = Body(native, 'FsusVaultMacStart');
    if (!manifest || !manifest.includes('".fsus/vault.json"')
        || (native.match(/\bread\s*\(/gu) ?? []).length !== (manifest.match(/\bread\s*\(/gu) ?? []).length) {
        violations.push('source-read-outside-fixed-control-manifest');
    }
    if (/\b(?:write|pwrite|unlink|unlinkat|remove|rename|renameat|mkdir|system|execve|fopen|printf|fprintf)\s*\(/u.test(native)
        || /\b(?:O_WRONLY|O_RDWR|O_CREAT|O_TRUNC)\b/u.test(native)) {
        violations.push('native-write-shell-or-content-log');
    }
    if (/\b(?:File|Directory)\.(?:Read\w*|Write\w*|Open\w*|Delete|Move|Create\w*)\s*\(/u.test(source)
        || /\b(?:HttpClient|ArticleVaultSyncPlanner|SaveLatest|SaveArticle|Console\.Write\w*|ILogger|DbContext)\b/u.test(source)) {
        violations.push('managed-body-read-write-planner-or-log');
    }
    if (!start || !start.includes('FSEventStreamCreate(') || !start.includes('FSEventStreamStart(')
        || !start.includes('kFSEventStreamCreateFlagWatchRoot') || !start.includes('kFSEventStreamCreateFlagFileEvents')
        || /\b(?:FileSystemWatcher|Timer|PeriodicTimer|Task\.Delay|Thread\.Sleep)\b/u.test(source)) {
        violations.push('native-stream-required-no-polling');
    }
    const release = ['FSEventStreamStop(', 'FSEventStreamInvalidate(', 'dispatch_sync_f(', 'FSEventStreamRelease(',
        'dispatch_release(', 'close(vault->descriptor)', 'free(vault)'];
    const positions = release.map((call) => teardown?.indexOf(call) ?? -1);
    if (positions.some((position) => position < 0)
        || positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
        violations.push('native-teardown-missing-or-unsafe-order');
    }
    const buffer = managed['MacVaultRawFactBuffer.cs'] ?? '';
    if (!buffer.includes('_facts.Count >= capacity') || !buffer.includes('_overflow ??= fact')
        || !buffer.includes('facts.Add(_overflow)') || buffer.includes('_facts.Clear(')) {
        violations.push('bounded-queue-or-preserved-overflow-required');
    }
    const session = managed['MacVaultWatcherSession.cs'] ?? '';
    if (!session.includes('"mac_vault_rescan_pending"') || !session.includes('reason, true, false, string.Empty')
        || /\b(?:AcknowledgeRescan|AcceptRescan|MarkClean|SaveLatest)\s*\(/u.test(source)) {
        violations.push('raw-fact-cannot-promote-clean-or-sync');
    }
    if (!native.includes('O_NOFOLLOW') || !native.includes('F_GETPATH')
        || !native.includes('CheckNames(') || !native.includes('SameMount(')
        || !source.includes('ArticleVaultPathStructureValidator.Analyze(')) {
        violations.push('native-and-shared-path-boundaries-required');
    }
    return violations;
}

export function ReadMacVaultObserver(root) {
    return {
        native: fs.readFileSync(path.join(root, sourceDirectory, 'native/MacVaultFSEvents.c'), 'utf8'),
        managed: Object.fromEntries(managedSources.map((name) => [name,
            fs.readFileSync(path.join(root, sourceDirectory, name), 'utf8')])),
    };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    if (process.argv.length !== 2) {
        throw new Error('This source check accepts no arguments.');
    }
    const files = ReadMacVaultObserver(process.cwd());
    const violations = AuditMacVaultObserver(files.native, files.managed);
    for (const violation of violations) {
        process.stderr.write(`${violation}\n`);
    }
    process.stdout.write(`macOS observer source obligations: ${violations.length} violations; native qualification=false\n`);
    process.exitCode = violations.length === 0 ? 0 : 1;
}
