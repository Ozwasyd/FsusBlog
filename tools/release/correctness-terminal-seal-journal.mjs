import { digestValue } from './browser-contract-receipt-contract.mjs';
import { createCorrectnessTerminalReceipt, verifyCorrectnessTerminalReceipt } from './correctness-terminal-receipt.mjs';

const packetSchema = 'fsusblog.correctness-terminal-seal-packet.v1';
const transitionSchema = 'fsusblog.correctness-terminal-seal-transition.v1';
const eventType = 'correctness-terminal-seal';

/** Attempt-owned append-only journal. The scheduler supplies durable canonical reverse-commit readback. */
export class CorrectnessTerminalSealJournal
{
    constructor({ store, targetAttemptId })
    {
        if (!store || typeof targetAttemptId !== 'string'
            || !/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(targetAttemptId)
            || /(?:^|[-_.])(?:issue|pr)[-_.]?\d+(?:$|[-_.])/iu.test(targetAttemptId))
        {
            throw new Error('correctness seal journal requires an explicit store and semantic attempt');
        }
        this.store = store;
        this.targetAttemptId = targetAttemptId;
    }

    state()
    {
        let previous = null;
        for (const event of this.store.readJournal())
        {
            if (event.eventType !== eventType || event.step !== this.targetAttemptId)
            {
                continue;
            }
            const record = this.store.readObject(event.payloadDigest).value;
            if (record.schema !== transitionSchema || record.runId !== this.store.runId
                || record.targetAttemptId !== this.targetAttemptId || record.status !== event.status
                || record.previousTransitionDigest !== (previous?.event.contentDigest ?? null)
                || record.contentDigest !== digestValue(record))
            {
                throw new Error('correctness seal transition identity/digest/chain mismatch');
            }
            if (!previous ? record.status !== 'prepared'
                : previous.record.status !== 'prepared' || !['finalized', 'rejected'].includes(record.status)
                    || record.packetRef !== previous.record.packetRef)
            {
                throw new Error('correctness seal transition is not append-only');
            }
            previous = { event, record };
        }
        return previous;
    }

    transition(status, packetRef, details = {})
    {
        const previous = this.state();
        const fields = status === 'finalized' ? ['finalObjectRef', 'finalizedCheckpointObjectRef']
            : status === 'rejected' ? ['reasonCode'] : [];
        if (!previous ? status !== 'prepared'
            : previous.record.status !== 'prepared' || previous.record.packetRef !== packetRef
                || !['finalized', 'rejected'].includes(status))
        {
            throw new Error('correctness seal transition cannot rewrite attempt history');
        }
        if (JSON.stringify(Object.keys(details).sort()) !== JSON.stringify(fields.sort()))
        {
            throw new Error('correctness seal transition has undeclared detail fields');
        }
        const record = {
            schema: transitionSchema,
            runId: this.store.runId,
            targetAttemptId: this.targetAttemptId,
            status,
            packetRef,
            previousTransitionDigest: previous?.event.contentDigest ?? null,
            ...details,
            contentDigest: null
        };
        record.contentDigest = digestValue(record);
        this.store.appendJournalEvent({ eventType, tier: 'production-correctness', step: this.targetAttemptId,
            status, payload: record });
        return this.state();
    }

    readPacket(packetRef)
    {
        const packet = this.store.readObject(packetRef).value;
        if (packet.schema !== packetSchema || packet.runId !== this.store.runId
            || packet.targetAttemptId !== this.targetAttemptId || packet.contentDigest !== digestValue(packet)
            || packet.inputs?.context?.runId !== this.store.runId
            || packet.inputs?.context?.targetAttemptId !== this.targetAttemptId
            || JSON.stringify(packet.inputs.context.sourceState) !== JSON.stringify(this.store.sourceState))
        {
            throw new Error('correctness seal packet crosses run/source/attempt boundary');
        }
        const expected = createCorrectnessTerminalReceipt(packet.inputs);
        if (packet.receipt.contentDigest !== expected.contentDigest
            || packet.receipt.contentDigest !== digestValue(packet.receipt))
        {
            throw new Error('correctness seal packet final digest mismatch');
        }
        return packet;
    }

    prepare(inputs)
    {
        const receipt = createCorrectnessTerminalReceipt(inputs);
        const packetInputs = Object.fromEntries(['context', 'provisional', 'snapshots', 'aggregateTerminalReceipt', 'finalizedAt']
            .map((field) => [field, structuredClone(inputs[field])]));
        const packet = { schema: packetSchema, runId: inputs.context.runId,
            targetAttemptId: inputs.context.targetAttemptId, inputs: packetInputs, receipt, contentDigest: null };
        packet.contentDigest = digestValue(packet);
        if (packet.runId !== this.store.runId || packet.targetAttemptId !== this.targetAttemptId)
        {
            throw new Error('correctness seal preparation crosses attempt boundary');
        }
        const previous = this.state();
        if (previous)
        {
            const existing = this.readPacket(previous.record.packetRef);
            if (existing.contentDigest !== packet.contentDigest)
            {
                throw new Error('correctness seal preparation cannot overwrite attempt history');
            }
            return { status: previous.record.status, packetRef: previous.record.packetRef };
        }
        const published = this.store.publishObject(packet);
        this.readPacket(published.digest);
        this.transition('prepared', published.digest);
        return { status: 'prepared', packetRef: published.digest };
    }

    finalize({ packetRef, finalizedCheckpoint })
    {
        const state = this.state();
        if (!state || state.record.packetRef !== packetRef || state.record.status === 'rejected')
        {
            throw new Error('correctness seal finalization requires this attempt explicit prepared ref');
        }
        if (state.record.status === 'finalized')
        {
            const result = this.resolve({ packetRef });
            if (result.finalizedCheckpoint.contentDigest !== finalizedCheckpoint?.contentDigest)
            {
                throw new Error('correctness seal finalized checkpoint cannot drift on retry');
            }
            return result;
        }
        const packet = this.readPacket(packetRef);
        verifyCorrectnessTerminalReceipt({ ...packet.inputs, receipt: packet.receipt, finalizedCheckpoint });
        const final = this.store.publishObject(packet.receipt);
        const reverse = this.store.publishObject(finalizedCheckpoint);
        this.transition('finalized', packetRef, { finalObjectRef: final.digest, finalizedCheckpointObjectRef: reverse.digest });
        return this.resolve({ packetRef });
    }

    reject({ packetRef, reasonCode })
    {
        const state = this.state();
        if (!state || state.record.packetRef !== packetRef || !reasonCode || typeof reasonCode !== 'string')
        {
            throw new Error('correctness seal rejection requires exact prepared ref and reason');
        }
        if (state.record.status === 'rejected')
        {
            return { status: 'rejected', packetRef };
        }
        if (state.record.status !== 'prepared')
        {
            throw new Error('correctness seal cannot rewrite finalized history');
        }
        this.transition('rejected', packetRef, { reasonCode });
        return { status: 'rejected', packetRef };
    }

    resolve({ packetRef })
    {
        const state = this.state();
        if (!state || state.record.packetRef !== packetRef || state.record.status !== 'finalized')
        {
            throw new Error('correctness seal has no consumable finalized current-attempt ref');
        }
        const packet = this.readPacket(packetRef);
        const receipt = this.store.readObject(state.record.finalObjectRef).value;
        const finalizedCheckpoint = this.store.readObject(state.record.finalizedCheckpointObjectRef).value;
        verifyCorrectnessTerminalReceipt({ ...packet.inputs, receipt, finalizedCheckpoint });
        return { status: 'finalized', packetRef, receipt, finalizedCheckpoint };
    }

    async recover({ packetRef, readFinalizedCheckpoint })
    {
        const state = this.state();
        if (!state || state.record.packetRef !== packetRef)
        {
            throw new Error('correctness seal recovery requires exact current-attempt journal ref');
        }
        if (state.record.status === 'rejected')
        {
            return { status: 'rejected', packetRef };
        }
        const packet = this.readPacket(packetRef);
        const checkpoint = await readFinalizedCheckpoint({ runId: this.store.runId, targetAttemptId: this.targetAttemptId,
            terminalParentRef: packet.receipt.terminalCheckpointRef, finalReceiptDigest: packet.receipt.contentDigest });
        return this.finalize({ packetRef, finalizedCheckpoint: checkpoint });
    }
}
