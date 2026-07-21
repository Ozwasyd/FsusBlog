export const workerRuntimeCases = [
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
        name: 'Reflect construct call remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = Reflect.construct.call(Reflect, globalThis.Worker, ['/worker.js'])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'Reflect construct apply remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = Reflect.construct.apply(Reflect, [globalThis.Worker, ['/worker.js']])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'bound Reflect construct remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst build = Reflect.construct.bind(Reflect)\nconst duplicateWorker = build(globalThis.Worker, ['/worker.js'])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'comma Reflect construct remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = (0, Reflect.construct)(globalThis.Worker, ['/worker.js'])"
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
        name: 'global object spread preserves Worker provenance',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst browserConstructors = { ...globalThis }\nconst duplicateWorker = new browserConstructors.Worker('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'global object rest preserves Worker provenance',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst { ...browserConstructors } = globalThis\nconst duplicateWorker = new browserConstructors.Worker('/worker.js')"
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
        name: 'stable let Worker alias remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nlet WorkerAlias = globalThis.Worker\nconst duplicateWorker = new WorkerAlias('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'object-stored Reflect construct remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst factories = { construct: Reflect.construct }\nconst duplicateWorker = factories.construct(globalThis.Worker, ['/worker.js'])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'globalThis Reflect construct remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = globalThis.Reflect.construct(globalThis.Worker, ['/worker.js'])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'window Reflect construct remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst duplicateWorker = window.Reflect.construct(globalThis.Worker, ['/worker.js'])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'global Reflect object alias remains forbidden in a host',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nconst R = globalThis.Reflect\nconst duplicateWorker = R.construct(globalThis.Worker, ['/worker.js'])"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'inner Worker alias writes do not pollute stable outer alias',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nlet WorkerAlias = globalThis.Worker\n{ let WorkerAlias = class SafeWorker {}; WorkerAlias = class OtherSafeWorker {} }\nconst duplicateWorker = new WorkerAlias('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'later Worker alias reassignment does not sanitize earlier construction',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nlet WorkerAlias = globalThis.Worker\nconst duplicateWorker = new WorkerAlias('/worker.js')\nWorkerAlias = class SafeWorker {}"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'reassigned destructured Worker alias is no longer browser Worker',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nlet { Worker: WorkerAlias } = globalThis\nWorkerAlias = class SafeWorker {}\nconst localWorker = new WorkerAlias()"
        ),
        shouldPass: true
    },
    {
        name: 'Worker alias reassigned to browser constructor remains forbidden',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nlet WorkerAlias = class SafeWorker {}\nWorkerAlias = globalThis.Worker\nconst duplicateWorker = new WorkerAlias('/worker.js')"
        ),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'array destructuring assignment sanitizes Worker alias',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace(
            '<script setup lang="ts">',
            "<script setup lang=\"ts\">\nlet WorkerAlias = globalThis.Worker\n;[WorkerAlias] = [class SafeWorker {}]\nconst localWorker = new WorkerAlias()"
        ),
        shouldPass: true
    },
    {
        name: 'var redeclaration reaches browser Worker constructor',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nvar WorkerAlias: any = class SafeWorker {}\nvar WorkerAlias: any = globalThis.Worker\nconst duplicateWorker = new WorkerAlias('/worker.js')"),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'conditional safe Worker write cannot erase eager initial value',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nlet WorkerAlias: any = globalThis.Worker\nif (false) WorkerAlias = class SafeWorker {}\nconst duplicateWorker = new WorkerAlias('/worker.js')"),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'uninvoked nested safe Worker write cannot erase eager initial value',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nlet WorkerAlias: any = globalThis.Worker\nfunction never() { WorkerAlias = class SafeWorker {} }\nconst duplicateWorker = new WorkerAlias('/worker.js')"),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'for-of assignment may reach browser Worker constructor',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nlet WorkerAlias: any = class SafeWorker {}\nfor (WorkerAlias of [globalThis.Worker]) { new WorkerAlias('/worker.js') }"),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'object destructuring assignment reaches browser Worker constructor',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nlet WorkerAlias: any = class SafeWorker {}\n;({ Worker: WorkerAlias } = globalThis)\nconst duplicateWorker = new WorkerAlias('/worker.js')"),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'logical Worker assignment may reach browser constructor',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nlet WorkerAlias: any = null\nWorkerAlias ||= globalThis.Worker\nconst duplicateWorker = new WorkerAlias('/worker.js')"),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'nullish Worker assignment may reach browser constructor',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nlet WorkerAlias: any = null\nWorkerAlias ??= globalThis.Worker\nconst duplicateWorker = new WorkerAlias('/worker.js')"),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'logical member assignment may reach browser Worker constructor',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nconst box: any = { W: null }\nbox.W ||= globalThis.Worker\nconst duplicateWorker = new box.W('/worker.js')"),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'conditional safe member write cannot erase browser Worker',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nconst box: any = { W: globalThis.Worker }\nif (false) box.W = class SafeWorker {}\nconst duplicateWorker = new box.W('/worker.js')"),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'nested object destructuring assignment reaches browser Worker',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nconst box: any = { W: class SafeWorker {} }\n;({ Worker: box.W } = globalThis)\nconst duplicateWorker = new box.W('/worker.js')"),
        expected: 'must not duplicate direct Worker construction'
    },
    {
        name: 'member update kills Worker constructor provenance',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nconst box: any = { W: globalThis.Worker }\nbox.W++\nconst localWorker = new box.W()"),
        shouldPass: true
    },
    {
        name: 'logical Reflect assignment may reach global Reflect object',
        file: 'src/frontend/src/components/security/FsusPoSpaceChallenge.vue',
        mutate: source => source.replace('<script setup lang="ts">', "<script setup lang=\"ts\">\nlet R: any = null\nR ||= globalThis.Reflect\nconst duplicateWorker = R.construct(globalThis.Worker, ['/worker.js'])"),
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
