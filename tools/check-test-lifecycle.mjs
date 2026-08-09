#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    buildLifecycleReport,
    classifyNodeRegistryEntry,
    isNodeTestFile,
    renderLifecycleMatrix
} from './test-lifecycle/lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.join(root, 'tests/governance/test-lifecycle-registry.json');
const outputPath = path.join(root, '.tmp/release-evidence/test-lifecycle-report.json');
const matrixPath = path.join(root, '.tmp/release-evidence/test-lifecycle-candidate-matrix.md');
const retentionInputPath = path.join(root, '.tmp/release-evidence/test-lifecycle-retention-input.json');
const writeRegistry = process.argv.includes('--write-registry');

const retention = spawnSync(process.execPath, [
    path.join(root, 'tools/check-test-retention.mjs'),
    '--out', retentionInputPath
], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
});
if (retention.status !== 0)
{
    process.stderr.write(retention.stderr || retention.stdout);
    process.exit(retention.status ?? 1);
}
const audit = JSON.parse(fs.readFileSync(retentionInputPath, 'utf8'));
if (writeRegistry)
{
    const existingRegistry = fs.existsSync(registryPath)
        ? JSON.parse(fs.readFileSync(registryPath, 'utf8'))
        : { nodeTests: [] };
    const existingStaticGovernance = new Map(
        (existingRegistry.nodeTests ?? [])
            .filter((entry) => entry.staticGovernance)
            .map((entry) => [entry.file, entry.staticGovernance])
    );
    const nodeTests = audit.files
        .filter(({ path: file }) => isNodeTestFile(file))
        .map(({ path: file }) =>
        {
            const staticGovernance = existingStaticGovernance.get(file);
            return {
                file,
                ...(staticGovernance
                    ? {
                        owner: 'repository-governance:static-node-contracts',
                        executionCategory: 'repository-governance',
                        lifecycle: 'canonical-execution',
                        physicalExecutionCount: 1,
                        classifications: classifyNodeRegistryEntry(
                            root,
                            file,
                            fs.readFileSync(path.join(root, file), 'utf8')
                        ).classifications,
                        staticGovernance
                      }
                    : classifyNodeRegistryEntry(root, file, fs.readFileSync(path.join(root, file), 'utf8')))
            };
        });
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, `${JSON.stringify({
        schema: 'fsusblog.test-lifecycle-registry.v1',
        policy: {
            newNodeTestsRequireExplicitOwner: true,
            timeOrAgeMayDecideLifecycle: false
        },
        nodeTests
    }, null, 4)}\n`);
    console.log(`[test-lifecycle] wrote registry nodeTests=${nodeTests.length}`);
    process.exit(0);
}

const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const { errors, report } = buildLifecycleReport({ audit, registry });
if (errors.length > 0)
{
    for (const error of errors)
    {
        console.error(`[test-lifecycle] ${error}`);
    }
    process.exit(1);
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(matrixPath, renderLifecycleMatrix(report));
console.log(`[test-lifecycle] ok files=${report.files.length} tests=${report.testRecords.length} node=${registry.nodeTests.length}`);
