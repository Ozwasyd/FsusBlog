import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { scanCompositionArchetypes } from '@fsusblog/layout-governance/composition-analyzer';
import { resolveLocalFsusUiRepositoryRoot } from '@fsusblog/layout-governance/fsusui-source-resolver';



export function checkLayoutComposition(repositoryRoot)
{
    const fsusUIRoot = resolveLocalFsusUiRepositoryRoot({ repositoryRoot, override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT });
    if (!fsusUIRoot)
    {
        throw new Error('[layout-composition] current effective FsusUI source unavailable');
    }
    return scanCompositionArchetypes({ repositoryRoot, fsusUIRoot });
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
{
    try
    {
        const receipt = checkLayoutComposition(resolve(import.meta.dirname, '../../../..'));
        const output = process.argv[2];
        if (output)
        {
            writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
        }
        for (const error of receipt.errors.slice(0, 20))
        {
            console.error(`[layout-composition] ${error.archetype ?? 'router'}: ${error.reason} ${error.file ?? error.path ?? ''}`);
        }
        console.log(`[layout-composition] archetypes=${receipt.archetypes.length} source-errors=${receipt.errors.length} rendered-dom=not-run full-visual=false`);
        if (receipt.errors.length)
        {
            process.exitCode = 1;
        }
    }
    catch (error)
    {
        console.error(error.message);
        process.exitCode = 1;
    }
}
