import { registryRelease } from './dependency-registry-release.mjs';

/** Resolve the catalog's rolling-default-branch target, not a hard-coded branch name. */
export async function readLatestGitRef(packageName, fetchJson, headers = {})
{
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\.git$/.exec(packageName);
    if (!match)
    {
        throw new Error('git_registry_package_invalid');
    }
    const repository = match[1];
    const repositoryUrl = `https://api.github.com/repos/${repository}`;
    const metadata = await fetchJson(repositoryUrl, headers);
    const branch = metadata.default_branch;
    if (typeof branch !== 'string' || branch.length === 0 || /[\x00-\x20\x7f]/.test(branch) // eslint-disable-line no-control-regex -- intentional ASCII-boundary probe
        || typeof metadata.full_name !== 'string' || metadata.full_name.toLowerCase() !== repository.toLowerCase())
    {
        throw new Error(`git_registry_default_branch_invalid:${repository}`);
    }
    const commit = await fetchJson(`${repositoryUrl}/commits/${encodeURIComponent(branch)}`, headers);
    if (!/^[0-9a-f]{40}$/.test(commit.sha ?? ''))
    {
        throw new Error(`git_registry_commit_invalid:${repository}`);
    }
    const after = await fetchJson(repositoryUrl, headers);
    if (after.default_branch !== branch || after.full_name !== metadata.full_name)
    {
        throw new Error(`git_registry_default_branch_changed:${repository}`);
    }
    return registryRelease(commit.sha, commit.commit?.committer?.date, `git-refs:${repository}`);
}
