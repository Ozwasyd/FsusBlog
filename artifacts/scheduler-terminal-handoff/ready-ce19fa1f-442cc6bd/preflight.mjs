import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const {inspectReleaseFinalCommandTarget} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/release-final-static-boundary.mjs')));
const targets = process.argv.slice(2);
const records = targets.map(target => {
  const source = fs.readFileSync(path.join(root, target), 'utf8');
  const callbacks = [...source.matchAll(/^test\('([^']+)'/gm)].map(m => m[1]);
  const selected = target.endsWith('release-final-verified-authority-binding.test.mjs')
    ? callbacks.filter(name => name === 'ordinary committed final output consumes the actual scheduler API and retains the wrapper digest without qualification') : callbacks;
  const inspection = inspectReleaseFinalCommandTarget({repositoryRoot: root, target});
  return {target, registeredCount: callbacks.length, selectedCount: selected.length, selected,
    excluded: callbacks.filter(name => !selected.includes(name)), globalHooks: /^(?:before|after|beforeEach|afterEach)\s*\(/m.test(source), inspection};
});
const output = {source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),node:process.version,
  stage:'ordinary-source-controls-only',authoritative:false, records};
console.log(JSON.stringify(output,null,2));
if(records.some(r => r.globalHooks || !r.selectedCount || r.inspection.errors.length)) process.exitCode=1;
