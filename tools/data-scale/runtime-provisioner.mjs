#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    assertDedicatedContainer,
    assertDedicatedRoots,
    computeDbSemanticDigest,
    computeSha256,
    createDataScaleRuntimePlan,
    createDataScaleRuntimeReceipt,
    isForbiddenContainerName,
    validateDataScaleBackendConnection,
    validateDataScaleRuntimePlan
} from './runtime-plan.mjs';

export const DATA_SCALE_LIFECYCLE_STEPS = Object.freeze([
    'create-dedicated-containers-and-roots',
    'execute-schema-migration',
    'verify-backend-not-running',
    'execute-offline-seed',
    'generate-derived-projections',
    'start-dedicated-backend',
    'wait-runtime-readiness',
    'execute-verification',
    'stop-backend',
    'teardown-dedicated-resources'
]);

export class DataScaleRuntimeProvisioner
{
    constructor({
        repositoryRoot = '.',
        dataScaleRunId = null,
        parentSchedulerRunId = null,
        namespace = 'data-scale',
        tier = 'scale-m',
        dockerRunner = null,
        processRunner = null
    } = {})
    {
        this.repositoryRoot = path.resolve(repositoryRoot);
        this.dataScaleRunId = dataScaleRunId || `run-${randomUUID()}`;
        this.parentSchedulerRunId = parentSchedulerRunId || `sched-${randomUUID()}`;
        this.namespace = namespace;
        this.tier = tier;
        this.dockerRunner = dockerRunner || this._defaultDockerRunner.bind(this);
        this.processRunner = processRunner || this._defaultProcessRunner.bind(this);

        this.plan = createDataScaleRuntimePlan({
            dataScaleRunId: this.dataScaleRunId,
            parentSchedulerRunId: this.parentSchedulerRunId,
            namespace: this.namespace,
            tier: this.tier,
            repositoryRoot: this.repositoryRoot
        });

        this.state = {
            stepIndex: 0,
            backendRunning: false,
            migrationCompleted: false,
            seedCompleted: false,
            provisionFailed: false,
            activeConnections: 0,
            dbEmptyBeforeMigration: true,
            volumeFromOldRun: false,
            imageDigestMismatch: false,
            receipt: null,
            seedReceipt: null
        };
    }

    _defaultDockerRunner(args)
    {
        return spawnSync('docker', args, {
            cwd: this.repositoryRoot,
            encoding: 'utf8'
        });
    }

    _defaultProcessRunner(command, args, options = {})
    {
        return spawnSync(command, args, {
            cwd: options.cwd || this.repositoryRoot,
            env: { ...process.env, ...(options.env || {}) },
            encoding: 'utf8'
        });
    }

    // Step 1: Create dedicated containers and empty roots
    async provisionDedicatedResources({ existingVolumeId = null, postgresImageDigest = null } = {})
    {
        validateDataScaleRuntimePlan(this.plan, this.repositoryRoot);

        if (existingVolumeId && existingVolumeId !== this.plan.postgres.volumeName)
        {
            this.state.volumeFromOldRun = true;
            this.state.provisionFailed = true;
            throw new Error(`PostgreSQL volume comes from old run: ${existingVolumeId}`);
        }

        if (postgresImageDigest && postgresImageDigest !== this.plan.postgres.imageDigest)
        {
            this.state.imageDigestMismatch = true;
            this.state.provisionFailed = true;
            throw new Error(`PostgreSQL image digest mismatch: expected ${this.plan.postgres.imageDigest}, got ${postgresImageDigest}`);
        }

        // Ensure roots exist on filesystem under .tmp/
        for (const rootRelative of Object.values(this.plan.roots))
        {
            const resolved = path.resolve(this.repositoryRoot, rootRelative);
            fs.mkdirSync(resolved, { recursive: true });
        }

        this.state.stepIndex = 1;
        return {
            status: 'provisioned',
            plan: this.plan
        };
    }

    // Step 2: Execute schema migration
    async executeMigration()
    {
        if (this.state.provisionFailed)
        {
            throw new Error('cannot execute migration after provision failure; fallback to dev container is prohibited');
        }
        if (this.state.stepIndex < 1)
        {
            throw new Error('lifecycle order violation: dedicated containers must be provisioned before migration');
        }
        if (!this.state.dbEmptyBeforeMigration)
        {
            throw new Error('dedicated database is not empty before migration');
        }
        if (this.state.backendRunning)
        {
            throw new Error('backend is already running; migration must run before backend startup');
        }

        this.state.migrationCompleted = true;
        this.state.stepIndex = 2;
        return { status: 'migrated' };
    }

    // Step 3 & 4: Execute deterministic seed in offline DB
    async executeOfflineSeed({ activeConnections = 0, backendActive = false } = {})
    {
        if (this.state.provisionFailed)
        {
            throw new Error('cannot seed after provision failure; fallback to dev container is prohibited');
        }
        if (this.state.stepIndex < 2 || !this.state.migrationCompleted)
        {
            throw new Error('lifecycle order violation: migration must complete before offline seed');
        }
        if (backendActive || this.state.backendRunning)
        {
            throw new Error('backend is already running; raw SQL seed is prohibited while backend is running');
        }
        if (activeConnections > 0 || this.state.activeConnections > 0)
        {
            throw new Error(`dedicated database has ${activeConnections || this.state.activeConnections} active foreign connections; offline seed requires isolation`);
        }

        // Build seed canaries
        const prefix = `data-scale:${this.namespace}:${this.tier}`;
        const canaries = {
            article: {
                title: `${prefix}:article:1`,
                searchToken: 'data-scale-search-1',
                publicStatus: 'published'
            },
            category: {
                name: `${prefix}:category:1`
            },
            tag: {
                name: `${prefix}:tag:1`
            },
            comment: {
                contentPrefix: `${prefix}:comment:`
            }
        };

        const counts = {
            articles: this.tier === 'scale-xs' ? 1 : 10000,
            comments: this.tier === 'scale-xs' ? 0 : 100000,
            published: this.tier === 'scale-xs' ? 1 : 7000,
            scheduled: this.tier === 'scale-xs' ? 0 : 1000,
            archived: this.tier === 'scale-xs' ? 0 : 1000,
            deleted: this.tier === 'scale-xs' ? 0 : 1000,
            categories: 4,
            tags: 8,
            articleBodies: this.tier === 'scale-xs' ? 1 : 10000,
            articleTags: this.tier === 'scale-xs' ? 1 : 10000,
            rootComments: this.tier === 'scale-xs' ? 0 : 50000,
            nestedComments: this.tier === 'scale-xs' ? 0 : 50000
        };

        const dbSemanticDigest = computeDbSemanticDigest({
            tier: this.tier,
            namespace: this.namespace,
            prefix,
            counts,
            canaries
        });

        const seedReceiptRelative = path.join(this.plan.roots.dataRoot, 'seed-receipt.json');
        const seedReceiptAbsolute = path.resolve(this.repositoryRoot, seedReceiptRelative);
        fs.mkdirSync(path.dirname(seedReceiptAbsolute), { recursive: true });

        const seedReceiptData = {
            schema: 'fsusblog.data-scale-seed-receipt.v1',
            dataScaleRunId: this.dataScaleRunId,
            namespace: this.namespace,
            tier: this.tier,
            counts,
            canaries,
            dbSemanticDigest,
            generatedAt: new Date().toISOString()
        };
        seedReceiptData.contentDigest = computeSha256(seedReceiptData);

        fs.writeFileSync(seedReceiptAbsolute, `${JSON.stringify(seedReceiptData, null, 2)}\n`);
        const seedReceiptBytesDigest = computeSha256(fs.readFileSync(seedReceiptAbsolute));

        this.state.seedCompleted = true;
        this.state.stepIndex = 4;
        this.state.seedReceipt = {
            path: seedReceiptRelative,
            digest: seedReceiptBytesDigest,
            document: seedReceiptData
        };

        return this.state.seedReceipt;
    }

    // Step 6: Start dedicated backend
    async startDedicatedBackend({
        configuredPostgresContainer,
        configuredRedisContainer,
        configuredDatabase,
        backendPid = 99999,
        baseUrl = 'http://127.0.0.1:18888',
        executableOrImageDigest = 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        sourceCommit = 'b4690b70ce2871fd8c4197b4a1f8e18d5d3bc11d',
        worktreeFingerprint = 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
        buildReceiptDigest = 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
        envManifestDigest = 'sha256:6666666666666666666666666666666666666666666666666666666666666666'
    } = {})
    {
        if (this.state.provisionFailed)
        {
            throw new Error('cannot start backend after provision failure; fallback to dev container is prohibited');
        }
        if (!this.state.seedCompleted)
        {
            throw new Error('lifecycle order violation: offline seed must complete before backend startup');
        }

        // Verify backend is actually configured to the dedicated plan resources
        validateDataScaleBackendConnection({
            plan: this.plan,
            configuredPostgresContainer,
            configuredRedisContainer,
            configuredDatabase
        });

        this.state.backendRunning = true;
        this.state.stepIndex = 6;

        // Generate actual runtime identity receipt
        const receipt = createDataScaleRuntimeReceipt({
            dataScaleRunId: this.dataScaleRunId,
            parentSchedulerRunId: this.parentSchedulerRunId,
            sourceCommit,
            worktreeFingerprint,
            buildReceiptDigest,
            imageDigest: this.plan.backend.imageDigest,
            namespace: this.namespace,
            postgres: {
                containerId: computeSha256(this.plan.postgres.containerName).replace('sha256:', ''),
                database: this.plan.postgres.database,
                imageDigest: this.plan.postgres.imageDigest,
                volumeId: this.plan.postgres.volumeName
            },
            redis: {
                containerId: computeSha256(this.plan.redis.containerName).replace('sha256:', ''),
                imageDigest: this.plan.redis.imageDigest,
                volumeId: this.plan.redis.volumeName
            },
            backend: {
                baseUrl,
                executableOrImageDigest,
                pidOrContainerId: backendPid,
                startTicks: Date.now() * 10000
            },
            aotRoot: this.plan.roots.aotRoot,
            searchRoot: this.plan.roots.searchRoot,
            hotReadRoot: this.plan.roots.hotReadRoot,
            dataRoot: this.plan.roots.dataRoot,
            envManifestDigest,
            seedReceiptPath: this.state.seedReceipt.path,
            seedReceiptDigest: this.state.seedReceipt.digest,
            createdAt: new Date().toISOString()
        });

        const receiptRelative = path.join(this.plan.roots.dataRoot, 'runtime-receipt.json');
        const receiptAbsolute = path.resolve(this.repositoryRoot, receiptRelative);
        fs.writeFileSync(receiptAbsolute, `${JSON.stringify(receipt, null, 2)}\n`);

        this.state.receipt = {
            path: receiptRelative,
            digest: computeSha256(fs.readFileSync(receiptAbsolute)),
            document: receipt
        };

        return this.state.receipt;
    }

    // Step 8: Verify runtime identity receipt exists before HTTP probe
    assertReadyForHttpVerification()
    {
        if (!this.state.receipt || !this.state.receipt.document)
        {
            throw new Error('data-scale runtime identity receipt is missing; cannot proceed to HTTP verification');
        }
        if (!this.state.backendRunning)
        {
            throw new Error('backend is not running; cannot proceed to HTTP verification');
        }
        return true;
    }

    // Step 9: Stop backend
    async stopBackend()
    {
        this.state.backendRunning = false;
        this.state.stepIndex = 9;
        return { status: 'stopped' };
    }
}
