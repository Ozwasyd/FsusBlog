import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { validateCpuCalibrationCohort } from './cpu-calibration-cohort.mjs';
import {
    assertCpuEqual, cpuAssertDigest, cpuDigest, exactCpuFields, freezeCpuValue, sealCpuValue, validateCpuIdentity, verifyCpuSeal
} from './cpu-calibration-contract.mjs';
import { verifyCpuCalibration } from './cpu-calibration-selection.mjs';
import { calculateEffectiveCpuFallback } from './effective-cpu-fallback.mjs';

export const cpuActivePointerSchema = 'fsusblog.cpu-calibration-active-pointer.v1';
export const cpuCapacitySelectionSchema = 'fsusblog.run-cpu-capacity-selection.v1';

function readReceipt(locator, digest)
{
    cpuAssertDigest(digest, 'immutable locator digest');
    if (typeof locator !== 'string' || !path.isAbsolute(locator) || path.basename(locator) !== `${digest.slice(7)}.json`)
    {
        throw new Error('immutable digest-named absolute receipt locator required');
    }
    if (!fs.lstatSync(locator).isFile() || fs.realpathSync(locator) !== locator)
    {
        throw new Error('CPU receipt must be a regular non-aliased file');
    }
    const value = JSON.parse(fs.readFileSync(locator, 'utf8'));
    if (value.contentDigest !== digest)
    {
        throw new Error('CPU locator digest mismatch');
    }
    return value;
}

function verifiedPointer(pointer)
{
    verifyCpuSeal(pointer, cpuActivePointerSchema);
    exactCpuFields(pointer, ['schema', 'calibrationLocator', 'calibrationDigest', 'cohortLocator',
        'cohortDigest', 'contentDigest'], 'active CPU pointer');
    const cohort = readReceipt(pointer.cohortLocator, pointer.cohortDigest);
    validateCpuCalibrationCohort(cohort);
    const calibration = readReceipt(pointer.calibrationLocator, pointer.calibrationDigest);
    verifyCpuCalibration(calibration, cohort);
    if (calibration.mode !== 'production')
    {
        throw new Error('contract fixture cannot activate Production calibration');
    }
    return calibration;
}

function syncFile(file)
{
    const descriptor = fs.openSync(file, 'r');
    try
    {
        fs.fsyncSync(descriptor);
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

/** Receipts are already immutable; rename is the single visibility/rollback boundary. */
export function activateCpuCalibration(pointerPath, reference, beforeRename = () =>
{})
{
    const pointer = sealCpuValue({ schema: cpuActivePointerSchema, ...reference });
    verifiedPointer(pointer);
    const directory = path.dirname(pointerPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.cpu-pointer-${randomUUID()}.tmp`);
    try
    {
        fs.writeFileSync(temporary, `${JSON.stringify(pointer)}\n`, { flag: 'wx', mode: 0o600 });
        syncFile(temporary);
        beforeRename();
        fs.renameSync(temporary, pointerPath);
        // Windows does not expose portable directory fsync through Node.
        if (process.platform !== 'win32')
        {
            syncFile(directory);
        }
    }
    finally
    {
        if (fs.existsSync(temporary))
        {
            fs.unlinkSync(temporary);
        }
    }
    return pointer;
}

/** Call once before plan sealing. Return an immutable receipt; no in-run reload method exists. */
export function resolveRunCpuCapacity({ runId, topology, identity, activePointerPath })
{
    validateCpuIdentity(identity);
    if (typeof runId !== 'string' || !runId)
    {
        throw new Error('CPU capacity run identity required');
    }
    const fallback = calculateEffectiveCpuFallback(topology, identity.topology);
    if (identity.machine !== topology.raw.machineIdentityDigest || identity.finiteBoundary !== fallback.finiteBoundaryDigest
        || identity.platform !== cpuDigest(topology.raw.platform) || identity.arch !== cpuDigest(topology.raw.arch)
        || identity.kernel !== cpuDigest(topology.raw.kernel) || identity.powerPolicy !== cpuDigest(topology.projection.power))
    {
        throw new Error('current CPU machine identity mismatch');
    }
    let calibration;
    let invalidReason = null;
    try
    {
        if (typeof activePointerPath !== 'string' || !path.isAbsolute(activePointerPath))
        {
            throw new Error('active CPU pointer missing');
        }
        if (!fs.lstatSync(activePointerPath).isFile() || fs.realpathSync(activePointerPath) !== activePointerPath)
        {
            throw new Error('active CPU pointer must be regular and non-aliased');
        }
        calibration = verifiedPointer(JSON.parse(fs.readFileSync(activePointerPath, 'utf8')));
        assertCpuEqual(calibration.identity, identity, 'current calibration identity');
        if (calibration.confidence !== 'clean-cohort'
            || calibration.effectiveCpuUnits > Math.min(fallback.allowedLogicalCpuCount, fallback.verifiedFiniteCpuLimitCores))
        {
            throw new Error('CPU calibration confidence/finite boundary invalid');
        }
    }
    catch (error)
    {
        calibration = null;
        invalidReason = String(error.message);
    }
    return sealCpuValue({ schema: cpuCapacitySelectionSchema, runId, identity,
        capacitySource: calibration ? 'calibration' : 'fallback',
        effectiveCpuUnits: calibration ? calibration.effectiveCpuUnits : fallback.effectiveCpuUnits,
        schedulerEnvelopeCpuUnits: calibration ? calibration.effectiveCpuUnits : fallback.schedulerEnvelopeCpuUnits,
        calibrationDigest: calibration ? calibration.contentDigest : null,
        fallbackReceipt: calibration ? null : fallback, invalidReason });
}

export function bindCpuCapacityToPlan(selection, { runId, identity })
{
    verifyCpuSeal(selection, cpuCapacitySelectionSchema);
    assertCpuEqual(selection.identity, identity, 'plan CPU identity');
    if (selection.runId !== runId)
    {
        throw new Error('plan CPU run identity mismatch');
    }
    return freezeCpuValue(structuredClone(selection));
}
