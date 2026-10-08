import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const sourcePolicy = { schema: 'fsusblog.repository-source-policy.v1', untracked: 'include', ignoredInputs: [] };

export function gitFixture(t)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-source-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Candidate Test');
    git('config', 'user.email', 'candidate@example.invalid');
    fs.writeFileSync(path.join(root, 'source.txt'), 'original\n');
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored-*\n');
    git('add', '.');
    git('commit', '-qm', 'fixture initial');
    return { root, git, write: (name, bytes) => fs.writeFileSync(path.join(root, name), bytes) };
}
