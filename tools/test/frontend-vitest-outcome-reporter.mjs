import fs from 'node:fs';

import { sealContentDigest } from './attempt-provenance.mjs';

function nativeCase(test)
{
    const diagnostic = test.diagnostic();
    return { taskId: test.id, source: test.module.moduleId, name: test.name,
        location: test.location ?? null, parent: { taskId: test.parent.id,
            location: test.parent.location ?? null, name: test.parent.name ?? null },
        options: test.options, result: test.result(), observation: test.meta().fsusOutcomeObservation ?? null,
        nativeCounters: diagnostic === undefined ? null
            : { retryCount: diagnostic.retryCount, repeatCount: diagnostic.repeatCount } };
}

export function nativeModule(module)
{
    return JSON.parse(JSON.stringify({ source: module.moduleId, projectName: module.project.name,
        cases: [...module.children.allTests()].map(nativeCase) }));
}

/** Durable native events retain execution progress even when the worker aborts. */
export default class FrontendVitestOutcomeReporter
{
    constructor(eventFile)
    {
        this.eventFile = eventFile;
        this.sequence = 0;
        this.previousDigest = null;
        fs.writeFileSync(eventFile, '', { flag: 'wx', mode: 0o600 });
    }

    record(event, value)
    {
        const entry = sealContentDigest({ schema: 'fsusblog.frontend-vitest-native-event.v1',
            sequence: this.sequence, previousDigest: this.previousDigest, event,
            value: JSON.parse(JSON.stringify(value)) });
        fs.appendFileSync(this.eventFile, `${JSON.stringify(entry)}\n`, { flush: true });
        this.sequence += 1;
        this.previousDigest = entry.contentDigest;
    }

    onTestModuleCollected(module)
    {
        this.record('collected', nativeModule(module));
    }

    onTestCaseReady(test)
    {
        this.record('ready', nativeCase(test));
    }

    onTestCaseResult(test)
    {
        this.record('result', nativeCase(test));
    }

    onTestRunEnd(modules, errors, reason)
    {
        this.record('end', { sources: modules.map((module) => module.moduleId), errors, reason });
    }
}
