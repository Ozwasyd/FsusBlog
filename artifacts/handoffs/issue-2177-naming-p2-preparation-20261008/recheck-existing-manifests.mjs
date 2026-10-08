import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {changedFilesBetween,validatePrContract} from '/tmp/fsusblog-2177-naming-authority-7f128208/tools/governance/change-contract.mjs';
const root='/workspace/FsusBlog-2177-formal-current-review';
const run=`${root}/.tmp/issue-2177-naming-p2-preparation-20261008`;
const base='7f128208dc59b408adda9089ff4e0a805ef2777d';
const head='c3155d51f27286d64fc8e18eeb759f3bd765315e';
const template=readFileSync(`${run}/current-proposed-pr-body.txt`,'utf8');
const changedFiles=changedFilesBetween(root,base,head);
const outputs=[];
for(const manifest of ['artifacts/change-contract/issue-2177-pure-comment-source-external-naming.json','artifacts/change-contract/backend-existing-reader-lock-external-naming.json']) {
 const body=template.replace(/- Exceptions manifest: [^\n]+/,`- Exceptions manifest: ${manifest}`);
 const errors=validatePrContract({title:'feat(backend): expose production shared comment policy inputs',body,labels:['release-note:internal'],actor:'Ozwasyd',changedFiles,root,base,head,authorityRoot:'/tmp/fsusblog-2177-naming-authority-7f128208'});
 outputs.push({manifest,errors,exitCode:errors.length?1:0,bodySha256:createHash('sha256').update(body).digest('hex')});
}
const report={createdAtUtc:new Date().toISOString(),stage:'current actual18-path proposed metadata; expected rejection; no future base invented',base,head,authoritySha:base,changedFilesCount:changedFiles.length,results:outputs,currentMetadataPassed:false,mergedLockIntegrationConfirmed:false,qualification:false};
writeFileSync(`${run}/current-existing-manifests-result.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if(outputs.some(x=>!x.errors.includes('External naming manifest paths must exactly match all changed registered naming surfaces')))process.exitCode=2;
