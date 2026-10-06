import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wrapperFile = fileURLToPath(new URL('./run-matrix-governance-once.sh', import.meta.url));
const matrixConsumers = ['matrix-governance', 'validate-matrix'];
const existingConsumers = [...matrixConsumers, 'release-evidence-plan', 'static-evidence-plan',
    'static-matrix-contract', 'static-matrix-schema'];

/** Read the existing shell's finite argv declaration; the original executable wrapper remains the source. */
export function matrixGovernanceArguments({ root, consumerId, preparationFile, environment = process.env })
{
    if (!existingConsumers.includes(consumerId) || (matrixConsumers.includes(consumerId) && !preparationFile))
        throw new Error('Matrix command requires its exact consumer and prepared descriptor');
    const stat = fs.lstatSync(wrapperFile);
    if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(wrapperFile) !== wrapperFile)
        throw new Error('Original matrix argv source is not canonical regular source');
    const source = fs.readFileSync(wrapperFile, 'utf8');
    const requiredPrefix = ['--key matrix-governance', '--execution-class correctness',
        '--producer-id "$CONSUMER_ID"', '--consumer "$CONSUMER_ID"', '--cwd "$ROOT_DIR"'];
    if (!requiredPrefix.every((value) => source.includes(value)))
        throw new Error('Original matrix wrapper has changed its fixed execution declaration');
    const paths = [...source.matchAll(/^    --path ([A-Za-z0-9_./-]+) \\$/gmu)].map((match) => match[1]);
    const testIds = [...source.matchAll(/^    --test-id ([A-Za-z0-9_-]+) \\$/gmu)].map((match) => match[1]);
    const native = source.match(/^    -- bash -c '([^'\r\n]+)'\s*$/mu)?.[1];
    if (!paths.length || !testIds.length || !native
        || (source.match(/^    --path /gmu)?.length ?? 0) !== paths.length
        || (source.match(/^    --test-id /gmu)?.length ?? 0) !== testIds.length)
        throw new Error('Original matrix wrapper has no closed finite input/command declaration');
    const argv = ['--key', 'matrix-governance', '--execution-class', 'correctness',
        '--producer-id', consumerId, '--consumer', consumerId,
        ...(matrixConsumers.includes(consumerId) ? ['--env', 'FSUSBLOG_CONTENT_FIELD_DOTNET', '--prepared-nuget', preparationFile] : []),
        '--cwd', root, '--projection-directory', environment.FSUSBLOG_PHYSICAL_EXECUTION_PROJECTION_DIR
            ?? '.tmp/physical-execution-projections'];
    for (const input of [...paths, 'tools/test/matrix-governance-command.mjs', 'tools/test/nuget-preparation-owner.mjs'])
        argv.push('--path', input);
    const docs = environment.FSUSBLOG_DOCS_EVIDENCE_DIR ?? '.tmp/docs';
    const outputTemplates = {
        '"${FSUSBLOG_RELEASE_EVIDENCE_DIR:-.tmp/release-evidence}/test-plan.json"':
            (environment.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? '.tmp/release-evidence') + '/test-plan.json',
        '.tmp/ci-plan.json': '.tmp/ci-plan.json', '.tmp/gate-logs/preflight.json': '.tmp/gate-logs/preflight.json',
        '"$DOCS_EVIDENCE_DIR/fast-backend-matrix.json"': docs + '/fast-backend-matrix.json',
        '"$DOCS_EVIDENCE_DIR/fast-frontend-unit-matrix.json"': docs + '/fast-frontend-unit-matrix.json',
        '"$DOCS_EVIDENCE_DIR/browser-contract-matrix.json"': docs + '/browser-contract-matrix.json'
    };
    const outputs = [...source.matchAll(/^    --output (.+) \\$/gmu)].map((match) => match[1]);
    if (outputs.length !== Object.keys(outputTemplates).length || new Set(outputs).size !== outputs.length
        || !outputs.every((output) => Object.hasOwn(outputTemplates, output)))
        throw new Error('Original matrix output declaration changed; its argv reader must be reviewed');
    for (const output of outputs) argv.push('--output', outputTemplates[output]);
    for (const testId of testIds) argv.push('--test-id', testId);
    return [...argv, '--', 'bash', '-c', native];
}
