#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    sealProjectionDocument
} from '../test-matrix/evidence-projection.mjs';
import {
    browserDiagnosticsReleaseAssertionsSchema,
    releasePolicyIdentity
} from '../test-matrix/release-domain-evidence.mjs';

function requiredEnvironment(name) {
    const value = String(process.env[name] ?? '').trim().replace(/^sha256:/u, '');
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function parseArguments(argv) {
    const values = {
        assertions: []
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--assertion') values.assertions.push(argv[++index]);
        else if (argument.startsWith('--')) values[argument.slice(2)] = argv[++index];
        else throw new Error(`unexpected argument: ${argument}`);
    }
    for (const field of ['category', 'probe', 'output']) {
        if (!String(values[field] ?? '').trim()) throw new Error(`--${field} is required`);
    }
    if (values.assertions.length === 0) throw new Error('at least one --assertion is required');
    return values;
}

function parseAssertions(values) {
    const assertions = values.map((value) => {
        const separator = String(value ?? '').lastIndexOf('=');
        if (separator <= 0) throw new Error(`invalid assertion result: ${value}`);
        const id = value.slice(0, separator);
        const outcome = value.slice(separator + 1);
        if (!['failure', 'success'].includes(outcome)) {
            throw new Error(`invalid assertion outcome for ${id}: ${outcome}`);
        }
        return { id, outcome };
    }).sort((left, right) => left.id.localeCompare(right.id));
    const ids = assertions.map((assertion) => assertion.id);
    if (new Set(ids).size !== ids.length) throw new Error('assertion IDs must be unique');
    return assertions;
}

function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
}

try {
    const options = parseArguments(process.argv.slice(2));
    const assertions = parseAssertions(options.assertions);
    const repositoryRoot = path.resolve(import.meta.dirname, '../..');
    const ledgerPath = path.join(repositoryRoot, 'config/testing/release-domain-assertion-dispositions.json');
    const sourceState = {
        commit: requiredEnvironment('FSUSBLOG_TEST_SOURCE_COMMIT'),
        worktreeFingerprint: requiredEnvironment('FSUSBLOG_TEST_SOURCE_FINGERPRINT')
    };
    if (!/^[a-f0-9]{40}$/u.test(sourceState.commit)
        || !/^[a-f0-9]{64}$/u.test(sourceState.worktreeFingerprint)) {
        throw new Error('release assertion source identity is invalid');
    }
    const receipt = sealProjectionDocument({
        schema: browserDiagnosticsReleaseAssertionsSchema,
        status: assertions.every((assertion) => assertion.outcome === 'success') ? 'success' : 'failure',
        categoryId: options.category,
        probeId: options.probe,
        diagnosticsRunId: requiredEnvironment('FSUSBLOG_BROWSER_DIAGNOSTICS_RUN_ID'),
        schedulerRunId: requiredEnvironment('FSUSBLOG_TEST_RUN_ID'),
        projectionNamespace: requiredEnvironment('FSUSBLOG_RELEASE_PROJECTION_NAMESPACE'),
        sourceState,
        buildReceiptDigest: `sha256:${requiredEnvironment('FSUSBLOG_BROWSER_DIAGNOSTICS_BUILD_DIGEST')}`,
        policyIdentity: releasePolicyIdentity(ledgerPath),
        assertions,
        generatedAt: new Date().toISOString()
    });
    const output = path.resolve(repositoryRoot, options.output);
    const relative = path.relative(repositoryRoot, output);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('--output must stay below the repository root');
    }
    writeJsonAtomic(output, receipt);
    process.stdout.write(
        `[browser-diagnostics-release-assertions] probe=${options.probe} status=${receipt.status} output=${relative.replaceAll(path.sep, '/')}\n`
    );
} catch (error) {
    process.stderr.write(
        `[browser-diagnostics-release-assertions] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
}
