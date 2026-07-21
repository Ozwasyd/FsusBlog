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
        name: 'call-invoked executor import is not lazy',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst eagerExecutorModule = (() => import('@/services/securityPoSpaceChallengeExecutor')).call(null)"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'apply-invoked executor import is not lazy',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst eagerExecutorModule = (() => import('@/services/securityPoSpaceChallengeExecutor')).apply(null)"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'comma IIFE executor import is not lazy',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst eagerExecutorModule = (0, () => import('@/services/securityPoSpaceChallengeExecutor'))()"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'module-top-level promise callback executor import is not lazy',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst eagerExecutorModule = Promise.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'top-level IIFE propagates through a nested local loader call',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst eagerExecutorModule = (() => { const load = () => import('@/services/securityPoSpaceChallengeExecutor'); return load() })()"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'module-top-level queueMicrotask callback executor import is proactive',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nqueueMicrotask(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'module-top-level synchronous array callback executor import is proactive',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst eagerExecutorModules = [0].map(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'Array prototype map call executor import is proactive',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst eagerExecutorModules = Array.prototype.map.call([0], () => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'Array prototype map apply callback list is proactive',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst eagerExecutorModules = Array.prototype.map.apply([0], [() => import('@/services/securityPoSpaceChallengeExecutor')])"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'aliased Array prototype map call is proactive',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst eagerMap = Array.prototype.map\nconst eagerExecutorModules = eagerMap.call([0], () => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'module-active helper propagates callback argument execution',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nfunction invokeNow(callback: () => unknown) { return callback() }\nconst eagerExecutorModule = invokeNow(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'user event helper callback remains deferred',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nfunction invokeNow(callback: () => unknown) { return callback() }\nwindow.addEventListener('click', () => invokeNow(() => import('@/services/securityPoSpaceChallengeExecutor')))"
        ),
        shouldPass: true
    },
    {
        name: 'user event path keeps nested scheduled and array loaders lazy',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nwindow.addEventListener('click', () => { const load = () => import('@/services/securityPoSpaceChallengeExecutor'); queueMicrotask(load); Promise.resolve().then(load); [0].map(load) })"
        ),
        shouldPass: true
    },
    {
        name: 'custom lazy map callback does not impersonate synchronous Array map',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst lazySequence = { map: (callback: () => unknown) => callback }\nconst deferredExecutorModule = lazySequence.map(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        shouldPass: true
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
        name: 'Vite root-absolute executor import remains eager',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport { createPoSpaceChallengeExecutor as eagerExecutor } from '/src/services/securityPoSpaceChallengeExecutor.ts'"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'Vite root-absolute executor type import is not eager',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport type { PoSpaceChallengeExecutor as ExecutorType } from '/src/services/securityPoSpaceChallengeExecutor.ts'"
        ),
        shouldPass: true
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
        name: 'statically computed solvePoSpaceProof access remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport * as duplicateRuntime from '@/services/securityPoSpaceRuntime'\nconst duplicateSolve = duplicateRuntime['solvePoSpace' + 'Proof']"
        ),
        expected: 'must not duplicate runtime proof solve'
    },
    {
        name: 'immutable string binding solvePoSpaceProof access remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport * as duplicateRuntime from '@/services/securityPoSpaceRuntime'\nconst solveKey = 'solvePoSpaceProof'\nconst duplicateSolve = duplicateRuntime[solveKey]"
        ),
        expected: 'must not duplicate runtime proof solve'
    },
    {
        name: 'immutable string metadata does not impersonate runtime solve access',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst solveKey = 'solvePoSpaceProof'\nconst runtimeLabels = { [solveKey]: 'worker-owned' }"
        ),
        shouldPass: true
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
        name: 'computed-property solvePoSpaceProof destructuring remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nimport * as duplicateRuntime from '@/services/securityPoSpaceRuntime'\nconst { ['solvePoSpaceProof']: duplicateSolve } = duplicateRuntime"
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
        name: 'unshadowed global Worker construction remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = new Worker('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'Reflect construct globalThis Worker remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = Reflect.construct(globalThis.Worker, ['/worker.js'])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'Reflect construct optional computed globalThis Worker remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = Reflect.construct(globalThis?.[`Worker`], ['/worker.js'])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'aliased Reflect construct remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst R = Reflect\nconst duplicateWorker = R.construct(globalThis.Worker, ['/worker.js'])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'destructured Reflect construct remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst { construct: build } = Reflect\nconst duplicateWorker = build(globalThis.Worker, ['/worker.js'])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'optional computed Reflect alias construct remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst R = Reflect\nconst duplicateWorker = R?.['construct'](globalThis.Worker, ['/worker.js'])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'parenthesized globalThis Worker construction remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = new (globalThis.Worker)('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'aliased globalThis Worker construction remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst WorkerAlias = globalThis.Worker\nconst duplicateWorker = new WorkerAlias('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'destructured globalThis Worker alias remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst { Worker: WorkerAlias } = globalThis\nconst duplicateWorker = new WorkerAlias('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'bound globalThis Worker alias remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst WorkerAlias = globalThis.Worker.bind(globalThis)\nconst duplicateWorker = new WorkerAlias('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'object-stored globalThis Worker alias remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst browserConstructors = { worker: globalThis.Worker }\nconst WorkerAlias = browserConstructors.worker\nconst duplicateWorker = new WorkerAlias('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'array-stored globalThis Worker alias remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst browserConstructors = [globalThis.Worker] as const\nconst WorkerAlias = browserConstructors[0]\nconst duplicateWorker = new WorkerAlias('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'object spread preserves globalThis Worker provenance',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst browserBase = { worker: globalThis.Worker } as const\nconst browserConstructors = { ...browserBase } as const\nconst WorkerAlias = browserConstructors.worker\nconst duplicateWorker = new WorkerAlias('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'array spread preserves globalThis Worker provenance',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst browserBase = [globalThis.Worker] as const\nconst browserConstructors = [...browserBase] as const\nconst WorkerAlias = browserConstructors[0]\nconst duplicateWorker = new WorkerAlias('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'custom destructured Worker constructor is not the browser Worker',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst customConstructors = { Worker: class LocalWorker {} }\nconst { Worker: WorkerAlias } = customConstructors\nconst localWorker = new WorkerAlias()"
        ),
        shouldPass: true
    },
    {
        name: 'local Worker property constructor is not the browser Worker',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst localBag = { Worker: class LocalWorker {} }\nconst localWorker = new localBag.Worker()"
        ),
        shouldPass: true
    },
    {
        name: 'local Worker destructuring is not the browser Worker',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst localBag = { Worker: class LocalWorker {} }\nconst { Worker: WorkerAlias } = localBag\nconst localWorker = new WorkerAlias()"
        ),
        shouldPass: true
    },
    {
        name: 'lexically shadowed Worker class is not the browser Worker',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nclass Worker {}\nconst localWorker = new Worker()"
        ),
        shouldPass: true
    },
    {
        name: 'statically computed Worker construction remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = new globalThis['Work' + 'er']('/worker.js')"
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
