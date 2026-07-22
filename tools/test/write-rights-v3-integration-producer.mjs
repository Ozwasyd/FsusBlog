#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const {
    createRightsV3IntegrationProducer,
    readTrxResults,
    repositoryPath,
    sha256File
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/rights-v3-projection.mjs')).href);

const trx = path.join(root, '.tmp/test-results/backend/integration.trx');
const output = path.join(root, '.tmp/test-results/backend/rights-v3-integration-producer.json');
const receipt = createRightsV3IntegrationProducer({
    sourceState: {
        commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
        worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
    },
    runId: process.env.FSUSBLOG_TEST_RUN_ID,
    namespace: process.env.FSUSBLOG_TEST_NAMESPACE,
    trxPath: repositoryPath(root, trx),
    trxDigest: sha256File(trx),
    results: readTrxResults([trx])
});
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(`${output}.next-${process.pid}`, `${JSON.stringify(receipt, null, 2)}\n`);
fs.renameSync(`${output}.next-${process.pid}`, output);
console.log(`[rights-v3-integration-producer] results=${receipt.results.length}`);
