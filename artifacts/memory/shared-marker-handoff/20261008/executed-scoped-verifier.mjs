import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {checkCodeIntent,validateMarkerRegistration} from '../../tools/governance/check-code-intent.mjs';
const root=process.cwd();
const paths=JSON.parse(fs.readFileSync('.tmp/memory-marker/paths.json'));
const baseline=JSON.parse(fs.readFileSync('tests/governance/code-intent-registry.json'));
function markerErrors(registry){return paths.flatMap(p=>validateMarkerRegistration({path:p,source:fs.readFileSync(p,'utf8'),registeredMarkers:new Set(registry.intents.flatMap(i=>i.anchors??[]).filter(a=>a.path===p).map(a=>a.marker))}));}
const supplied=JSON.parse(fs.readFileSync('.tmp/memory-marker/registry.json'));
const result={head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),paths,sourceBlobs:Object.fromEntries(paths.map(p=>[p,execFileSync('git',['rev-parse',`HEAD:${p}`],{encoding:'utf8'}).trim()])),negativeControl:markerErrors(baseline),suppliedMarkers:markerErrors(supplied),scoped:checkCodeIntent({root,registryPath:'.tmp/memory-marker/registry.json',files:paths})};
fs.writeFileSync('.tmp/memory-marker/result.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({head:result.head,negativeCount:result.negativeControl.length,suppliedCount:result.suppliedMarkers.length,scoped:result.scoped}));
process.exitCode=result.suppliedMarkers.length||result.scoped.errors.length?1:0;
