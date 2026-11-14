const { parseYamlDocument } = await import(new URL('../../yaml/parse-document.mjs', import.meta.url));
import { admitMaterial, checkGraphMaterial, exactFields, requireFact, sealProjection } from './projection-contract.mjs';

/**
 * Validate launch facts extracted by the canonical transitive-input owner.
 * This component does not replace that owner's Shell/Node/TS parser or discover
 * files. It checks exact child ownership and narrowly bound tool descendants.
 */
export function analyzeExecutableAuthorityMaterial(input, hostLimits)
{
    const material = admitMaterial(input, hostLimits);
    exactFields(material, ['graph', 'launches'], 'executable authority input');
    const byId = checkGraphMaterial(material.graph);
    requireFact(Array.isArray(material.launches), 'launch facts required');
    const findings = [];
    const owners = new Map();
    const locations = new Set();
    for (const launch of material.launches)
    {
        exactFields(launch, ['location', 'parentId', 'childId', 'producerId', 'owner', 'migrationEntry',
            'dynamic', 'failureMode', 'role', 'descendantProof'], 'launch fact');
        exactFields(launch.location, ['path', 'line', 'column'], 'launch location');
        const node = byId.get(launch.parentId);
        requireFact(node && typeof launch.location.path === 'string' && Number.isSafeInteger(launch.location.line)
            && launch.location.line > 0 && Number.isSafeInteger(launch.location.column) && launch.location.column > 0,
        'exact parent/source location required');
        const key = `${launch.location.path}:${launch.location.line}:${launch.location.column}`;
        requireFact(!locations.has(key), 'duplicate launch location');
        locations.add(key);
        const report = (code) => findings.push({ code, location: launch.location, parentId: launch.parentId,
            childId: launch.childId, owner: launch.owner, migrationEntry: launch.migrationEntry });
        requireFact(typeof launch.dynamic === 'boolean', 'dynamic launch fact required');
        requireFact(['fail-closed', 'continue-on-error', 'ignore-exit', 'catch-and-continue', 'reset-attempt']
            .includes(launch.failureMode), 'closed launch failure mode required');
        if (launch.dynamic)
        {
            report('undeclared-dynamic-launch');
        }
        if (launch.failureMode !== 'fail-closed')
        {
            report('failure-swallowed');
        }
        if (launch.role === 'correctness')
        {
            if (!['producer', 'hard-prerequisite'].includes(node.kind))
            {
                report('coordination-launches-correctness');
            }
            if (!byId.has(launch.producerId) || launch.producerId !== launch.parentId
                || !launch.childId || !launch.owner || !launch.migrationEntry || launch.descendantProof !== null)
            {
                report('child-owner-not-exact');
            }
            const children = owners.get(launch.parentId) ?? [];
            children.push(launch);
            owners.set(launch.parentId, children);
        }
        else if (launch.role === 'tool-descendant')
        {
            const proof = launch.descendantProof;
            if (!proof || launch.producerId !== launch.parentId)
            {
                report('descendant-proof-missing');
            }
            else
            {
                exactFields(proof, ['ownerCommandDigest', 'childCommandDigest', 'purpose', 'outputOwner',
                    'testIds', 'evidenceIds', 'proofTestId'], 'tool descendant proof');
                if (!/^sha256:[a-f0-9]{64}$/u.test(proof.ownerCommandDigest)
                    || !/^sha256:[a-f0-9]{64}$/u.test(proof.childCommandDigest)
                    || !proof.purpose || proof.outputOwner !== launch.parentId || !proof.proofTestId
                    || !Array.isArray(proof.testIds) || proof.testIds.length
                    || !Array.isArray(proof.evidenceIds) || proof.evidenceIds.length)
                {
                    report('descendant-proof-not-owner-bound');
                }
            }
        }
        else if (launch.role === 'cleanup')
        {
            if (node.kind !== 'finalizer' || launch.producerId !== null || launch.descendantProof !== null)
            {
                report('cleanup-owner-invalid');
            }
        }
        else
        {
            report('unknown-executable-role');
        }
    }
    for (const launches of owners.values())
    {
        if (launches.length > 1)
        {
            for (const launch of launches)
            {
                findings.push({ code: 'hidden-executable-authorities', location: launch.location,
                    parentId: launch.parentId, childId: launch.childId, owner: launch.owner,
                    migrationEntry: launch.migrationEntry, hiddenChildIds: launches.map((child) => child.childId).sort() });
            }
        }
    }
    for (const node of material.graph.nodes.filter((entry) => entry.evidenceClass === 'correctness'
        && ['producer', 'hard-prerequisite'].includes(entry.kind)))
    {
        if (!owners.has(node.id))
        {
            findings.push({ code: 'executable-authority-missing',
                location: { path: material.graph.graphRef.path, line: 1, column: 1 }, parentId: node.id,
                childId: null, owner: null, migrationEntry: null });
        }
    }
    findings.sort((a, b) => a.location.path.localeCompare(b.location.path)
        || a.location.line - b.location.line || a.location.column - b.location.column || a.code.localeCompare(b.code));
    return sealProjection({ schema: 'fsusblog.executable-authority-analysis-material.v1', graphRef: material.graph.graphRef,
        dagDigest: material.graph.dagDigest, launchCount: material.launches.length,
        accepted: findings.length === 0, findings });
}

// Finite literal command grammar for package/workflow source analysis. Unsupported
// shell grammar fails closed; it is not a general shell parser or closure proof.
function literalCommands(source)
{
    requireFact(typeof source === 'string' && source.length > 0, 'literal command required');
    const commands = [];
    let argv = [];
    let word = '';
    let started = false;
    let quote = null;
    let swallow = false;
    const pushWord = () =>
    {
        if (started)
        {
            argv.push(word);
        }
        word = '';
        started = false;
    };
    const pushCommand = () =>
    {
        pushWord();
        if (argv.length)
        {
            commands.push(argv);
        }
        argv = [];
    };
    for (let index = 0; index < source.length; index += 1)
    {
        const character = source[index];
        requireFact(!['$', '`', '\\'].includes(character), 'dynamic/escaped shell command requires canonical parser');
        if (quote)
        {
            if (character === quote)
            {
                quote = null;
            }
            else
            {
                word += character;
            }
            continue;
        }
        if (character === '"' || character === "'")
        {
            quote = character;
            started = true;
        }
        else if (/\s/u.test(character))
        {
            if (character === '\n')
            {
                pushCommand();
            }
            else
            {
                pushWord();
            }
        }
        else if (character === ';' || character === '&' || character === '|')
        {
            if (source.slice(index, index + 2) === '||')
            {
                swallow = true;
            }
            requireFact(character !== '|' || source[index + 1] === '|', 'pipeline requires canonical parser');
            pushCommand();
            if (source[index + 1] === character)
            {
                index += 1;
            }
        }
        else
        {
            requireFact(!['(', ')', '{', '}', '<', '>', '#'].includes(character), 'shell structure requires canonical parser');
            word += character;
            started = true;
        }
    }
    requireFact(quote === null, 'unterminated shell quote');
    pushCommand();
    return { commands, swallow };
}

/** Inspect all script bodies, expanding literal npm script refs without running them. */
export function inspectPackageScriptMaterial(packageDocument, hostLimits)
{
    const document = admitMaterial(packageDocument, hostLimits);
    requireFact(document.scripts && typeof document.scripts === 'object' && !Array.isArray(document.scripts), 'package scripts required');
    const scripts = [];
    const expand = (id, stack) =>
    {
        requireFact(!stack.includes(id), 'package script cycle');
        requireFact(Object.hasOwn(document.scripts, id), 'package script reference missing');
        const parsed = literalCommands(document.scripts[id]);
        let swallow = parsed.swallow;
        const commands = parsed.commands.flatMap((argv) =>
        {
            if ((argv[0] === 'npm' && argv[1] === 'run') || (argv[0] === 'pnpm' && argv[1] === 'run'))
            {
                requireFact(argv.length === 3, 'package script forwarding arguments require canonical parser');
                const child = expand(argv[2], [...stack, id]);
                swallow ||= child.swallow;
                return child.commands;
            }
            requireFact(!['npm-run-all', 'run-p', 'run-s', 'concurrently'].includes(argv[0]), 'parallel runner requires explicit child manifest');
            requireFact(!(argv[0] === 'set' && argv.includes('+e')) && argv[0] !== 'true', 'failure swallowing command rejected');
            return [argv];
        });
        return { commands, swallow };
    };
    for (const id of Object.keys(document.scripts).sort())
    {
        scripts.push({ scriptId: id, ...expand(id, []) });
    }
    return sealProjection({ schema: 'fsusblog.package-command-analysis-material.v1', scripts });
}

/** Extract actual workflow run steps and unsafe job flags using the repository YAML parser. */
export function inspectWorkflowCommandMaterial(source, sourcePath, hostLimits)
{
    const input = admitMaterial({ source, sourcePath }, hostLimits);
    const document = parseYamlDocument(input.source, { source: input.sourcePath });
    requireFact(document.jobs && typeof document.jobs === 'object', 'workflow jobs required');
    const jobs = [];
    for (const [id, job] of Object.entries(document.jobs).sort(([left], [right]) => left.localeCompare(right)))
    {
        requireFact(job && Array.isArray(job.steps), 'workflow steps required');
        const commands = [];
        let failureSwallowed = Object.hasOwn(job, 'continue-on-error') && job['continue-on-error'] !== false;
        for (const [index, step] of job.steps.entries())
        {
            failureSwallowed ||= Object.hasOwn(step, 'continue-on-error') && step['continue-on-error'] !== false;
            if (Object.hasOwn(step, 'run'))
            {
                const parsed = literalCommands(step.run);
                failureSwallowed ||= parsed.swallow;
                commands.push({ stepIndex: index, commands: parsed.commands });
            }
        }
        jobs.push({ id, commands, failureSwallowed,
            failFast: job.strategy ? job.strategy['fail-fast'] !== false : false });
    }
    return sealProjection({ schema: 'fsusblog.workflow-command-analysis-material.v1', sourcePath: input.sourcePath, jobs });
}
