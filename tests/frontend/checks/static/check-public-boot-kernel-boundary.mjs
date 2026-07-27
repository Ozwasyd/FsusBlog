import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(process.cwd(), '..', '..');
const composer = readFileSync(resolve(repoRoot, 'src/backend/Infrastructure/PublicAot/PublicAotDocumentComposer.cs'), 'utf8');
const kernel = readFileSync(resolve(repoRoot, 'src/frontend/src/bootstrap/publicBootKernel.ts'), 'utf8');
const handoff = readFileSync(resolve(repoRoot, 'src/frontend/src/bootstrap/publicBootHandoff.ts'), 'utf8');
const entry = readFileSync(resolve(repoRoot, 'src/frontend/src/bootstrap/entry.ts'), 'utf8');
const repositorySources = [
    composer,
    readFileSync(resolve(repoRoot, 'src/backend/Infrastructure/PublicAot/PublicAotDocumentService.cs'), 'utf8'),
    kernel,
    handoff,
    entry
].join('\n');

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(`[public-boot-kernel-boundary] ${message}`);
    }
}

const retiredMethod = ['BuildDeferred', 'SpaBootScript'].join('');
try
{
    const matches = execFileSync(
        'git',
        ['grep', '-n', retiredMethod, '--', 'src', 'tests', 'tools', 'docs'],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    assert(false, `retired method is still referenced:\n${matches}`);
}
catch (error)
{
    assert(error?.status === 1, `retired method search failed: ${error?.message ?? String(error)}`);
}

assert(composer.includes('BuildPublicBootMarkup'), 'backend must emit public boot markup');
for (const forbidden of ['requestIdleCallback', "addEventListener('pointerdown'", 'createPolicy', 'warmPreload'])
{
    assert(!composer.includes(forbidden), `backend must not embed boot behavior: ${forbidden}`);
}
for (const forbidden of ["@/bootstrap/fullApp", "@/bootstrap/publicShell", "@/router/", "from 'vue'", "from 'pinia'", 'FsusUI'])
{
    assert(!kernel.includes(forbidden), `BootKernel must not own application composition: ${forbidden}`);
}
for (const forbidden of ['CustomEvent', retiredMethod, ['fsus', 'spa', 'boot'].join('-')])
{
    assert(!repositorySources.includes(forbidden), `retired bootstrap contract must stay absent: ${forbidden}`);
}
assert(
    /consumePublicBootHandoff\(frontendBuildIdentity\)/u.test(entry),
    'entry must compare the handoff with its current build identity'
);
for (const mark of ['public-boot-preload', 'public-boot-entry-injected'])
{
    assert(
        kernel.includes(`mark('${mark}')`) && entry.includes(`'${mark}'`),
        `BootKernel and entry must agree on startup mark ${mark}`
    );
}
assert(
    /finally\s*\{\s*carrier\.remove\(\)/u.test(handoff),
    'handoff carrier must be destroyed on success and every mismatch'
);
assert(
    /Array\.isArray\(value\)[\s\S]*value\.every\(isSameOriginAssetUrl\)/u.test(kernel),
    'BootKernel must validate every configured asset URL'
);
assert(
    /cleanupScheduling\(\)[\s\S]*findEntryScript\(\)/u.test(kernel),
    'BootKernel must own cancellable scheduling and existing-entry detection'
);

console.log('[public-boot-kernel-boundary] configuration, scheduling, handoff, and application ownership OK');
