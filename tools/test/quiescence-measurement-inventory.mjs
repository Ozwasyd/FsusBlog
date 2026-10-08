import fs from 'node:fs';
import path from 'node:path';

const {quiescenceDigest} = await import(new URL('../test-matrix/quiescence-contract.mjs', import.meta.url));

export const measurementQuiescenceInventoryPath = 'config/testing/measurement-quiescence-consumers.json';
const root = path.resolve(import.meta.dirname, '../..');

export function loadMeasurementQuiescenceConsumers(authorityRoot = root)
{
    const inventory = JSON.parse(fs.readFileSync(path.join(authorityRoot, measurementQuiescenceInventoryPath), 'utf8'));
    if (inventory.schema !== 'fsusblog.measurement-quiescence-consumers.v1' || !Array.isArray(inventory.consumers) ||
        new Set(inventory.consumers.map((entry) => entry.consumerId)).size !== inventory.consumers.length ||
        inventory.consumers.some((entry) => !entry.consumerId ||
            !['requires-quiescence', 'non-quiescent-worker-measurement'].includes(entry.stateContract) ||
            !fs.existsSync(path.join(authorityRoot, entry.owner))))
    {
        throw new Error('measurement quiescence consumer inventory invalid');
    }
    return {...inventory, contentDigest: quiescenceDigest(inventory)};
}

export function requireMeasurementQuiescenceConsumer(consumerId, authorityRoot = root)
{
    const declaration = loadMeasurementQuiescenceConsumers(authorityRoot).consumers.find((entry) => entry.consumerId === consumerId);
    if (!declaration)
    {
        throw new Error(`unknown measurement quiescence consumer: ${consumerId}`);
    }
    return declaration;
}

// There is no production locator/current-lease transport or cross-process holder
// authority in the current repository. A marker, caller file or env string cannot
// stand in for it. This is the actual source-entry refusal, before producer spawn.
export function assertProductionMeasurementQuiescenceAvailable(consumerId)
{
    requireMeasurementQuiescenceConsumer(consumerId);
    throw Object.assign(new Error('protected production quiescence locator/lease/holder authority unavailable'),
        {classification: 'infra.quiescence-precondition', producerSpawnCount: 0});
}

export function retainedQuiescenceConsumerForWindow(windowId)
{
    const id = String(windowId).includes('/performance-evidence/') ? String(windowId).split('/').at(-1) : windowId;
    const known = loadMeasurementQuiescenceConsumers().consumers.some((entry) => entry.consumerId === id);
    if (known || /^(?:load-profile-|release-resource-budget-|soak-|backend-native-)/u.test(id) || String(windowId).includes('/performance-evidence/'))
    {
        requireMeasurementQuiescenceConsumer(id);
        return id;
    }
    // Other offline/noise/scheduler ports are outside this retained consumer set.
    return null;
}
