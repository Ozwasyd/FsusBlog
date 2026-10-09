import fs from 'node:fs';
import { runExtractor } from '/workspace/.task-toolchains/3556/renderer-composition/tools/fact-extractors/runner.mjs';
import { loadRegistry, validateRegistry, validateOwnershipAgainstBehaviorCatalog } from '/workspace/.task-toolchains/3556/renderer-composition/tools/fact-extractors/registry.mjs';
import { loadCatalog, validateCatalog } from '/workspace/.task-toolchains/3556/renderer-composition/tools/contracts/behavior-contract-catalog.mjs';
import { runMinimalContractBuild } from '/workspace/.task-toolchains/3556/renderer-composition/tools/docs/behavior-doc-minimal-contract-build.mjs';
import { validateMinimalContractBuildReceipt } from '/workspace/.task-toolchains/3556/renderer-composition/tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs';
import { sealSourceIdentity } from '/workspace/.task-toolchains/3556/renderer-composition/tools/fact-extractors/identity.mjs';
const repositoryRoot='/workspace/.task-toolchains/3556/renderer-composition';
const evidenceRoot='/workspace/3556-evidence/renderer-composition';
const runId=`chain-3556-renderer-composition-observations-${Date.now()}`;
const identity=sealSourceIdentity(repositoryRoot);
const registry=loadRegistry(`${repositoryRoot}/config/contracts/behavior-fact-extractors.json`);
const catalog=loadCatalog(`${repositoryRoot}/config/contracts/behavior-contracts.json`);
validateCatalog(catalog,repositoryRoot); validateRegistry(registry,repositoryRoot);
validateOwnershipAgainstBehaviorCatalog(registry,catalog,repositoryRoot);
const output=`${evidenceRoot}/fact-observations`;fs.mkdirSync(output,{recursive:true});
const results={runId,sourceIdentity:identity,observations:{},minimalBuild:null,errors:[]};
function save(){fs.writeFileSync(`${evidenceRoot}/current-observations-result.json`,JSON.stringify(results,null,2)+'\n');}
async function observe(extractor,minimal=null){
 const receiptPath=`${output}/${extractor.id}.json`;
 const result=await runExtractor({extractorId:extractor.id,repositoryRoot,registry,useCache:false,buildIdentity:extractor.requiredBuildArtifact===null?null:minimal.buildIdentities[extractor.requiredBuildArtifact],buildReceiptPath:extractor.requiredBuildArtifact===null?null:minimal.identityReceiptFile,minimalBuildReceiptValidator:validateMinimalContractBuildReceipt});
 fs.writeFileSync(receiptPath,JSON.stringify(result.receipt,null,2)+'\n');
 results.observations[extractor.id]={status:result.receipt.status,contentDigest:result.receipt.contentDigest,receiptPath,failureReasons:result.receipt.failureReasons};
 save();console.log(`${extractor.id}: ${result.receipt.status}`);
 if(result.receipt.status!=='ok')throw Error(`${extractor.id}: ${result.receipt.failureReasons.join('; ')}`);
}
for(const extractor of registry.extractors.filter(x=>x.requiredBuildArtifact===null)){
 try {await observe(extractor);}catch(error){results.errors.push(String(error));save();}
}
try {
 console.log('Starting original current-source minimal contract build');
 const minimal=runMinimalContractBuild({repositoryRoot,runId,sourceIdentity:identity});
 results.minimalBuild={receipt:minimal.receipt,receiptFile:minimal.receiptFile,identityReceiptFile:minimal.identityReceiptFile};save();
 for(const extractor of registry.extractors.filter(x=>x.requiredBuildArtifact!==null)){
  try {await observe(extractor,minimal);}catch(error){results.errors.push(String(error));save();}
 }
}catch(error){results.errors.push(String(error));save();console.error(error);}
save();process.exitCode=results.errors.length?1:0;
