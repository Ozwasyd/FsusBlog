export const hostRuntimeCases = [
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
    }
];
