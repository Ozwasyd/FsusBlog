#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { checkPoSpaceRuntimeReachability } from './check-pospace-runtime-reachability.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const checkerPath = path.join(repoRoot, 'tests/frontend/checks/static/check-pospace-runtime-reachability.mjs');
const sourcePaths = [
    'src/frontend/src/security/challenge-capability-registry.ts',
    'src/frontend/src/services/securityPoSpaceChallengeExecutor.ts',
    'src/frontend/src/services/securityPoSpaceClient.ts',
    'src/frontend/src/services/securityPoSpaceRuntime.ts',
    'src/frontend/src/workers/security/pospace.worker.ts',
    'src/frontend/src/components/security/FsusSecurityChallenge.vue',
    'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
    'src/frontend/src/composables/useNotification.ts'
];

const cases = [
    {
        name: 'missing component runtime edge',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            "import('@/services/securityPoSpaceChallengeExecutor')",
            "import('@/services/unreachablePoSpaceChallengeExecutor')"
        ),
        expected: 'must keep the dynamic-import edge'
    },
    {
        name: 'comment cannot impersonate component runtime edge',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            "import('@/services/securityPoSpaceChallengeExecutor')",
            "import('@/services/unreachablePoSpaceChallengeExecutor')"
        ).replace(
            '<script setup lang="ts">',
            "<!-- import('@/services/securityPoSpaceChallengeExecutor') -->\n<script setup lang=\"ts\">"
        ),
        expected: 'must keep the dynamic-import edge'
    },
    {
        name: 'string cannot impersonate component runtime edge',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            "import('@/services/securityPoSpaceChallengeExecutor')",
            "import('@/services/unreachablePoSpaceChallengeExecutor')"
        ).replace(
            '</script>',
            "const dynamicImportDecoy = \"import('@/services/securityPoSpaceChallengeExecutor')\"\n</script>"
        ),
        expected: 'must keep the dynamic-import edge'
    },
    {
        name: 'type-only notification edge',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            /const \{ createPoSpaceChallengeExecutor \} = await import\(\s*'@\/services\/securityPoSpaceChallengeExecutor'\s*\)/u,
            'const createPoSpaceChallengeExecutor = injectedExecutorFactory'
        ),
        expected: 'must keep the dynamic-import edge'
    },
    {
        name: 'module-top-level executor prefetch is not lazy',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst eagerExecutorModule = import('@/services/securityPoSpaceChallengeExecutor')"
        ).replace(
            /const \{ createPoSpaceChallengeExecutor \} = await import\(\s*'@\/services\/securityPoSpaceChallengeExecutor'\s*\)/u,
            'const { createPoSpaceChallengeExecutor } = await eagerExecutorModule'
        ),
        expected: 'must keep the dynamic-import edge'
    },
    {
        name: 'function-deferred executor import remains lazy',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst deferredExecutorModule = () => import('@/services/securityPoSpaceChallengeExecutor')"
        ),
        shouldPass: true
    },
    {
        name: 'immediately invoked executor import is not lazy',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst eagerExecutorModule = (() => import('@/services/securityPoSpaceChallengeExecutor'))()"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'eager component executor regression',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport { createPoSpaceChallengeExecutor } from '@/services/securityPoSpaceChallengeExecutor'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'namespace eager component executor regression',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport * as PoSpaceExecutorModule from '@/services/securityPoSpaceChallengeExecutor'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'relative eager component executor regression',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport PoSpaceExecutorModule from '../../services/securityPoSpaceChallengeExecutor'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'TypeScript Bundler relative js executor import remains eager',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport { createPoSpaceChallengeExecutor as eagerExecutor } from '../../services/securityPoSpaceChallengeExecutor.js'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'TypeScript Bundler relative js dynamic import remains a valid lazy edge',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            "import('@/services/securityPoSpaceChallengeExecutor')",
            "import('../../services/securityPoSpaceChallengeExecutor.js')"
        ),
        shouldPass: true
    },
    {
        name: 'same-basename decoy dynamic import is not the canonical executor edge',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            "import('@/services/securityPoSpaceChallengeExecutor')",
            "import('@/decoys/securityPoSpaceChallengeExecutor.js')"
        ),
        expected: 'must keep the dynamic-import edge'
    },
    {
        name: 'TypeScript Bundler relative mjs executor import remains eager',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport { createPoSpaceChallengeExecutor as eagerExecutor } from '../../services/securityPoSpaceChallengeExecutor.mjs'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'TypeScript Bundler relative cjs executor import remains eager',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport { createPoSpaceChallengeExecutor as eagerExecutor } from '../../services/securityPoSpaceChallengeExecutor.cjs'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'TypeScript Bundler relative js type import is not eager',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport type { PoSpaceChallengeExecutor as ExecutorType } from '../../services/securityPoSpaceChallengeExecutor.js'"
        ),
        shouldPass: true
    },
    {
        name: 'value export star executor regression',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script lang="ts">',
            "<script lang=\"ts\">\nexport * from '@/services/securityPoSpaceChallengeExecutor'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'named value re-export executor regression',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script lang="ts">',
            "<script lang=\"ts\">\nexport { createPoSpaceChallengeExecutor } from '@/services/securityPoSpaceChallengeExecutor'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'TypeScript Bundler relative js value re-export remains eager',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script lang="ts">',
            "<script lang=\"ts\">\nexport { createPoSpaceChallengeExecutor } from '../../services/securityPoSpaceChallengeExecutor.js'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'namespace value re-export executor regression',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script lang="ts">',
            "<script lang=\"ts\">\nexport * as PoSpaceExecutorModule from '@/services/securityPoSpaceChallengeExecutor'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'default value re-export executor regression',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script lang="ts">',
            "<script lang=\"ts\">\nexport { default } from '../../services/securityPoSpaceChallengeExecutor'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'inline type-only re-export executor is not an eager edge',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script lang="ts">',
            "<script lang=\"ts\">\nexport { type PoSpaceChallengeExecutor } from '@/services/securityPoSpaceChallengeExecutor'"
        ),
        shouldPass: true
    },
    {
        name: 'multiline component runtime edge remains valid',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            "import('@/services/securityPoSpaceChallengeExecutor')",
            "import(\n        '@/services/securityPoSpaceChallengeExecutor'\n      )"
        ),
        shouldPass: true
    },
    {
        name: 'template script-looking text remains valid SFC content',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<template>',
            "<template>\n  <span>{{ '<script>' }}</span>"
        ),
        shouldPass: true
    },
    {
        name: 'Argon2 type-only import is not a runtime implementation',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport type { ArgonOpts } from '@noble/hashes/argon2.js'"
        ),
        shouldPass: true
    },
    {
        name: 'solvePoSpaceProof type alias is not a runtime implementation',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            '<script setup lang="ts">\ntype solvePoSpaceProof = { readonly brand: unique symbol }'
        ),
        shouldPass: true
    },
    {
        name: 'ambient solve declaration is not a runtime implementation',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            '<script setup lang="ts">\ndeclare const solvePoSpaceProof: unknown'
        ),
        shouldPass: true
    },
    {
        name: 'declare global solve contract is not a runtime implementation',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script lang="ts">',
            '<script lang="ts">\ndeclare global { const solvePoSpaceProof: () => void }'
        ),
        shouldPass: true
    },
    {
        name: 'declare module solve contract is not a runtime implementation',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script lang="ts">',
            "<script lang=\"ts\">\ndeclare module 'virtual:pospace-contract' { export const solvePoSpaceProof: () => void }"
        ),
        shouldPass: true
    },
    {
        name: 'indexed solve type is not a runtime implementation',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script lang="ts">',
            "<script lang=\"ts\">\ntype SolveProperty = { solvePoSpaceProof: () => void }['solvePoSpaceProof']"
        ),
        shouldPass: true
    },
    {
        name: 'Argon2 value import remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport { argon2idAsync } from '@noble/hashes/argon2.js'"
        ),
        expected: 'must not duplicate Argon2 implementation import'
    },
    {
        name: 'solvePoSpaceProof value implementation remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            '<script setup lang="ts">\nconst solvePoSpaceProof = () => undefined'
        ),
        expected: 'must not duplicate runtime proof solve'
    },
    {
        name: 'computed solvePoSpaceProof access remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport * as duplicateRuntime from '@/services/securityPoSpaceRuntime'\nconst duplicateSolve = duplicateRuntime['solvePoSpaceProof']"
        ),
        expected: 'must not duplicate runtime proof solve'
    },
    {
        name: 'computed solvePoSpaceProof destructuring remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport * as duplicateRuntime from '@/services/securityPoSpaceRuntime'\nconst { 'solvePoSpaceProof': duplicateSolve } = duplicateRuntime"
        ),
        expected: 'must not duplicate runtime proof solve'
    },
    {
        name: 'solvePoSpaceProof value re-export remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script lang="ts">',
            "<script lang=\"ts\">\nexport { solvePoSpaceProof } from '@/services/securityPoSpaceRuntime'"
        ),
        expected: 'must not duplicate runtime proof solve'
    },
    {
        name: 'solvePoSpaceProof type-only re-export is not a runtime implementation',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script lang="ts">',
            "<script lang=\"ts\">\nexport type { solvePoSpaceProof } from '@/services/securityPoSpaceRuntime'"
        ),
        shouldPass: true
    },
    {
        name: 'globalThis Worker construction remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = new globalThis.Worker('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'window Worker construction remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = new window.Worker('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'self computed Worker construction remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = new self['Worker']('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'Worker metadata property is not Worker construction',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst workerMetadata = { Worker: 'dedicated' }"
        ),
        shouldPass: true
    }
];

function createFixtureRoot()
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-pospace-reachability-'));
    for (const relative of sourcePaths)
    {
        const destination = path.join(root, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(path.join(repoRoot, relative), 'utf8'));
    }
    return root;
}

for (const testCase of cases)
{
    const root = createFixtureRoot();
    try
    {
        const target = path.join(root, testCase.file);
        const original = readFileSync(target, 'utf8');
        const mutated = testCase.mutate(original);
        assert.notEqual(mutated, original, `${testCase.name} fixture must alter its source`);
        writeFileSync(target, mutated);

        if (testCase.shouldPass)
        {
            assert.doesNotThrow(
                () => checkPoSpaceRuntimeReachability(root),
                `${testCase.name} must preserve the runtime edge`
            );
            continue;
        }

        assert.throws(
            () => checkPoSpaceRuntimeReachability(root),
            error => error instanceof assert.AssertionError
        && new RegExp(testCase.expected, 'u').test(error.message),
            `${testCase.name} must fail for the expected reason`
        );
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
}

const poisonedRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-pospace-authority-'));
try
{
    const result = spawnSync(process.execPath, [checkerPath], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, FSUSBLOG_POSPACE_REACHABILITY_ROOT: poisonedRoot }
    });
    assert.equal(
        result.status,
        0,
        `environment variables must not replace the authoritative scan root: ${result.stderr || result.stdout}`
    );
}
finally
{
    rmSync(poisonedRoot, { recursive: true, force: true });
}

console.log(`[pospace-runtime-reachability-fixture] ok cases=${cases.length}`);
