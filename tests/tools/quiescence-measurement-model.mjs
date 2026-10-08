// Explicit unit-owner output model; this never establishes live runtime authority.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const {createProductionFreshOutputRoot, outputPath, captureProductionFreshOutputInventory, sealTerminalProductionFreshOutputs} = await import(new URL('../../tools/test-matrix/production-fresh-run-bound-outputs.mjs', import.meta.url));
const {createProductionFreshOutputLocator} = await import(new URL('../../tools/test-matrix/production-fresh-output-locator.mjs', import.meta.url));
const bytesDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function sealedModelOutput(t, receipt, additionalOutputs = () => [])
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-quiescence-locator-'));
    t.after(() =>
    {
        const writable = (directory) =>
        {
            for (const item of fs.readdirSync(directory, {withFileTypes: true}))
            {
                const file = path.join(directory, item.name);
                if (item.isDirectory())
                {
                    writable(file);
                }
                else if (item.isFile())
                {
                    fs.chmodSync(file, 0o600);
                }
            }
            fs.chmodSync(directory, 0o700);
        };
        writable(root);
        fs.rmSync(root, {recursive: true, force: true});
    });
    const layout = createProductionFreshOutputRoot({root, runId: receipt.runId});
    const relativePath = 'reports/unit-model-quiescence.json';
    const file = outputPath(layout, relativePath);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify(receipt));
    const extra = additionalOutputs(root, layout);
    for (const output of extra)
    {
        const outputFile = outputPath(layout, output.relativePath);
        fs.mkdirSync(path.dirname(outputFile), {recursive: true});
        fs.writeFileSync(outputFile, JSON.stringify(output.document));
    }
    const outputs = [{relativePath, document: receipt}, ...extra];
    const perOutputDigest = Object.fromEntries(outputs.map((output) =>
        [output.relativePath, bytesDigest(fs.readFileSync(outputPath(layout, output.relativePath)))]));
    const producerId = 'quiescence-model-writer';
    const producer = {schema: 'fsusblog.production-fresh.producer-receipt.v1', runId: layout.runId,
        attemptId: layout.attemptId, producerId, outputRoot: layout.relativeOutputRoot,
        relativeOutputs: outputs.map((output) => output.relativePath), perOutputDigest,
        outputInventoryDigest: bytesDigest(JSON.stringify(perOutputDigest)), status: 'complete'};
    const producerFile = outputPath(layout, `artifacts/producer-receipts/${producerId}.json`);
    fs.mkdirSync(path.dirname(producerFile), {recursive: true});
    fs.writeFileSync(producerFile, JSON.stringify(producer));
    const inventoryDigest = bytesDigest(JSON.stringify(captureProductionFreshOutputInventory(layout)));
    sealTerminalProductionFreshOutputs(layout);
    const locators = Object.fromEntries(outputs.map((output) => [output.relativePath, createProductionFreshOutputLocator({
        schema: output.document.schema, runId: receipt.runId,
        attemptId: layout.attemptId, producerId, producerReceiptRef: path.relative(root, producerFile),
        producerReceiptDigest: bytesDigest(fs.readFileSync(producerFile)), outputInventoryDigest: inventoryDigest,
        relativePath: output.relativePath, contentDigest: perOutputDigest[output.relativePath],
        candidateIdentityDigest: receipt.candidateIdentityDigest})]));
    return {root, locator: locators[relativePath], relatedLocators: locators};
}

