export const executorReachabilityCases = [
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
        name: 'object method helper propagates callback argument execution',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst helpers = { invokeNow(callback: () => unknown) { return callback() } }\nhelpers.invokeNow(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'destructured object method propagates callback argument execution',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst helpers = { invokeNow(callback: () => unknown) { return callback() } }\nconst { invokeNow } = helpers\ninvokeNow(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'helper apply spread propagates callback argument execution',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nfunction invokeNow(callback: () => unknown) { return callback() }\nconst callbackArgs = [() => import('@/services/securityPoSpaceChallengeExecutor')] as const\ninvokeNow.apply(null, [...callbackArgs])"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'custom then callback remains deferred',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst lazyThenable = { then: (callback: () => unknown) => callback }\nlazyThenable.then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        shouldPass: true
    },
    {
        name: 'shadowed Promise then callback remains deferred',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst Promise = { resolve: () => ({ then: (callback: () => unknown) => callback }) }\nPromise.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        shouldPass: true
    },
    {
        name: 'shadowed queueMicrotask callback remains deferred',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst queueMicrotask = (callback: () => unknown) => callback\nqueueMicrotask(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        shouldPass: true
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
        name: 'class static helper propagates callback argument execution',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nclass Helpers { static invokeNow(callback: () => unknown) { return callback() } }\nHelpers.invokeNow(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'aliased Promise resolve callback is proactive',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst P = Promise\nP.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'bound Promise resolve callback is proactive',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst resolveNow = Promise.resolve.bind(Promise)\nresolveNow().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'globalThis Promise resolve callback is proactive',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nglobalThis.Promise.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'window Promise resolve callback is proactive',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nwindow.Promise.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'shadowed Array instance map callback remains deferred',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nclass Array { map(callback: () => unknown) { return callback } }\nnew Array().map(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        shouldPass: true
    },
    {
        name: 'shadowed Array from map callback remains deferred',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nclass Array { static from() { return { map: (callback: () => unknown) => callback } } }\nArray.from().map(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        shouldPass: true
    },
    {
        name: 'inner Promise alias writes do not pollute stable outer alias',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nconst P = Promise\n{ let P = { resolve: () => ({ then: (callback: () => unknown) => callback }) }; P = { resolve: () => ({ then: (callback: () => unknown) => callback }) } }\nP.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'later Promise alias reassignment does not sanitize earlier proactive use',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nlet P = Promise\nP.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))\nP = { resolve: () => ({ then: (callback: () => unknown) => callback }) }"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'reassigned class static helper keeps callback deferred',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nclass Helpers { static invokeNow(callback: () => unknown) { return callback() } }\nHelpers.invokeNow = (callback: () => unknown) => callback\nHelpers.invokeNow(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        shouldPass: true
    },
    {
        name: 'Promise alias reassigned to native constructor is proactive',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nlet P = { resolve: () => ({ then: (callback: () => unknown) => callback }) }\nP = Promise\nP.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'reassigned helper class keeps callback deferred',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nlet Helpers = class { static invokeNow(callback: () => unknown) { return callback() } }\nHelpers = class { static invokeNow(callback: () => unknown) { return callback } }\nHelpers.invokeNow(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        shouldPass: true
    },
    {
        name: 'var redeclaration reaches native Promise constructor',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nvar P: any = { resolve: () => ({ then: (callback: () => unknown) => callback }) }\nvar P: any = Promise\nP.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'conditional safe Promise write cannot erase eager initial value',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nlet P: any = Promise\nif (false) P = { resolve: () => ({ then: (callback: () => unknown) => callback }) }\nP.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'uninvoked nested safe Promise write cannot erase eager initial value',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nlet P: any = Promise\nfunction never() { P = { resolve: () => ({ then: (callback: () => unknown) => callback }) } }\nP.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'logical Promise assignment may reach native constructor',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nlet P: any = null\nP ||= Promise\nP.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'nullish Promise assignment may reach native constructor',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nlet P: any = null\nP ??= Promise\nP.resolve().then(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'conditional safe helper write cannot erase eager class method',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nclass Helpers { static invokeNow(callback: () => unknown) { return callback() } }\nif (false) Helpers.invokeNow = (callback: () => unknown) => callback\nHelpers.invokeNow(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'loop safe helper write cannot erase eager class method',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nclass Helpers { static invokeNow(callback: () => unknown) { return callback() } }\nfor (let index = 0; index < 0; index++) Helpers.invokeNow = (callback: () => unknown) => callback\nHelpers.invokeNow(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'class static callback property is resolved as eager helper',
        file: 'src/frontend/src/composables/useNotification.ts',
        mutate: source => source.replace(
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'",
            "import { poSpaceV1Contract } from '@/generated/poSpaceV1Contract'\n\nclass Helpers { static invokeNow = (callback: () => unknown) => callback() }\nHelpers.invokeNow(() => import('@/services/securityPoSpaceChallengeExecutor'))"
        ),
        expected: 'must keep the PoSpace executor lazy'
    },
    {
        name: 'template script-looking text remains valid SFC content',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<template>',
            "<template>\n  <span>{{ '<script>' }}</span>"
        ),
        shouldPass: true
    }
];
