import fs from 'node:fs';
import path from 'node:path';

export function validateCustomizationDag(dagData)
{
    const nodes = new Set(dagData.nodes);
    const inDegree = new Map();
    const adj = new Map();

    for (const node of nodes)
    {
        inDegree.set(node, 0);
        adj.set(node, []);
    }

    for (const edge of dagData.edges)
    {
        if (!nodes.has(edge.from) || !nodes.has(edge.to))
        {
            throw new Error(`Unknown cross-item reference in edge: ${edge.from} -> ${edge.to}`);
        }
        adj.get(edge.from).push(edge.to);
        inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
    }

    const queue = [];
    for (const [node, deg] of inDegree.entries())
    {
        if (deg === 0)
        {
            queue.push(node);
        }
    }

    let visitedCount = 0;
    while (queue.length > 0)
    {
        const curr = queue.shift();
        visitedCount++;
        for (const neighbor of adj.get(curr))
        {
            inDegree.set(neighbor, inDegree.get(neighbor) - 1);
            if (inDegree.get(neighbor) === 0)
            {
                queue.push(neighbor);
            }
        }
    }

    const cycles = nodes.size - visitedCount;
    return {
        cycles,
        totalNodes: nodes.size,
        edgesCount: dagData.edges.length
    };
}

export function validateCustomizationOwnership(ownershipData)
{
    const typeToOwner = new Map();
    let duplicateOwners = 0;
    let unownedSharedContracts = 0;

    for (const [type, owner] of Object.entries(ownershipData.ownership))
    {
        if (!owner)
        {
            unownedSharedContracts++;
        }
        else if (typeToOwner.has(type))
        {
            duplicateOwners++;
        }
        else
        {
            typeToOwner.set(type, owner);
        }
    }

    return {
        duplicateOwners,
        unownedSharedContracts,
        totalTypes: typeToOwner.size
    };
}

export function runCheck()
{
    const root = process.cwd();
    const dagPath = path.join(root, 'config/customization-dependency-dag.json');
    const ownershipPath = path.join(root, 'config/customization-contracts-ownership.json');

    if (!fs.existsSync(dagPath) || !fs.existsSync(ownershipPath))
    {
        throw new Error('Customization configuration files missing');
    }

    const dagData = JSON.parse(fs.readFileSync(dagPath, 'utf8'));
    const ownershipData = JSON.parse(fs.readFileSync(ownershipPath, 'utf8'));

    const dagResult = validateCustomizationDag(dagData);
    const ownershipResult = validateCustomizationOwnership(ownershipData);

    if (dagResult.cycles !== 0)
    {
        throw new Error(`Dependency DAG contains ${dagResult.cycles} cycles`);
    }
    if (ownershipResult.duplicateOwners !== 0)
    {
        throw new Error(`Found ${ownershipResult.duplicateOwners} duplicate contract owners`);
    }
    if (ownershipResult.unownedSharedContracts !== 0)
    {
        throw new Error(`Found ${ownershipResult.unownedSharedContracts} unowned shared contracts`);
    }

    console.log(`[customization-contracts] ok: cycles=${dagResult.cycles}, duplicateOwners=${ownershipResult.duplicateOwners}, unowned=${ownershipResult.unownedSharedContracts}`);
}

if (process.argv[1] && process.argv[1].endsWith('check-customization-contracts.mjs'))
{
    try
    {
        runCheck();
    }
    catch (err)
    {
        console.error(`[customization-contracts] FAILED: ${err.message}`);
        process.exit(1);
    }
}
