import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createDefaultVisualRuntimeConfig,inspectVisualRuntime} from '/workspace/FsusUI/scripts/visual-runtime-core.mjs';
const target='.tmp/visual-runtime/artifacts/icons/index.js';const original=await fs.readFile(target);const config=createDefaultVisualRuntimeConfig(process.cwd());const report={sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),before:await inspectVisualRuntime(config)};
try {assert.equal(report.before.ready,true);await fs.appendFile(target,'\n// isolated paint-candidate corruption negative\n');report.corrupted=await inspectVisualRuntime(config);assert.equal(report.corrupted.ready,false);}
finally {await fs.writeFile(target,original);report.restored=await inspectVisualRuntime(config);await fs.writeFile('/tmp/chain-830-surface-evidence/artifact-negative.json',JSON.stringify(report,null,2)+'\n');}
assert.equal(report.restored.ready,true);console.log('actual artifact corruption rejected and original bytes restored');
