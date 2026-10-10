import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const { snapshotRepositorySourceIdentity } = await import(new URL('../test/repository-source-snapshot.mjs', import.meta.url));

export { snapshotRepositorySourceIdentity as collectSourceWorktreeIdentity };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        const args = process.argv.slice(2);
        if (args.length !== 4 || args[0] !== '--repo' || args[2] !== '--policy')
        {
            throw new Error('usage: collect-source-worktree.mjs --repo <explicit-root> --policy <source-policy.json>');
        }
        const receipt = snapshotRepositorySourceIdentity(args[1], { sourcePolicy: JSON.parse(fs.readFileSync(args[3], 'utf8')) });
        process.stdout.write(`${JSON.stringify(receipt, null, 4)}\n`);
    }
    catch (error)
    {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
