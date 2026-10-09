import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from '/workspace/chain1975-intent-source-alias-verification/src/frontend/node_modules/typescript/lib/typescript.js';
const root='/workspace/chain1975-provider-facts-only';
const out='/workspace/chain-1975-evidence/facts-contract-boundary';
const files=['src/frontend/src/api/uploadFacts.ts','src/frontend/src/adapters/binary/uploadAdapter.ts','src/frontend/src/contracts/binaryApi.ts'];
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const results=[];
for(const file of files){
 const before=fs.readFileSync(path.join(out,'preimage-'+path.basename(file)),'utf8');const after=fs.readFileSync(path.join(root,file),'utf8');
 const compilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,verbatimModuleSyntax:true,removeComments:true,sourceMap:false};
 const oldEmission=ts.transpileModule(before,{compilerOptions,fileName:file,reportDiagnostics:true});const newEmission=ts.transpileModule(after,{compilerOptions,fileName:file,reportDiagnostics:true});
 if(oldEmission.outputText!==newEmission.outputText)throw new Error('runtime emission differs '+file);
 if(oldEmission.diagnostics?.length||newEmission.diagnostics?.length)throw new Error('transpile diagnostic '+file);
 results.push({file,runtimeEmissionIdentical:true,preimageRuntimeSha256:hash(oldEmission.outputText),postimageRuntimeSha256:hash(newEmission.outputText),emitterScope:'official TS6 removeComments, no sourceMap; emission comparison, not full application typecheck'});
}
const oldContracts=fs.readFileSync(path.join(out,'preimage-binaryApi.ts'),'utf8');const newContracts=fs.readFileSync(path.join(root,files[2]),'utf8');
if(!newContracts.startsWith(oldContracts))throw new Error('existing contract fields changed');
function alias(source,file){const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);const found=tree.statements.find(n=>ts.isTypeAliasDeclaration(n)&&n.name.text==='UploadAssetFactsViewModel');if(!found)throw new Error('alias missing');return found.getText(tree);}
const originalAlias=alias(fs.readFileSync(path.join(out,'preimage-uploadAdapter.ts'),'utf8'),'old-adapter.ts');const movedAlias=alias(newContracts,'new-contracts.ts');
if(originalAlias!==movedAlias)throw new Error('alias expression changed');
const temp=fs.mkdtempSync(path.join(out,'actual-contract-type-proof-'));
try{
 function preview(source,file){const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);const node=tree.statements.find(n=>ts.isInterfaceDeclaration(n)&&n.name.text==='UploadAssetPreviewViewModel');if(!node)throw new Error('real preview declaration missing');return node.getText(tree);}
 const oldPreview=preview(oldContracts,'old-contracts.ts');const newPreview=preview(newContracts,'new-contracts.ts');if(oldPreview!==newPreview)throw new Error('original referenced interface changed');
 fs.writeFileSync(path.join(temp,'old-contracts.ts'),oldPreview+'\n');fs.writeFileSync(path.join(temp,'new-contracts.ts'),newPreview+'\n'+movedAlias+'\n');
 fs.writeFileSync(path.join(temp,'old-facts.ts'),"import type { UploadAssetPreviewViewModel } from './old-contracts';\n"+originalAlias+'\n');
 fs.writeFileSync(path.join(temp,'proof.ts'),`import type { UploadAssetFactsViewModel as Before } from './old-facts';
import type { UploadAssetFactsViewModel as After } from './new-contracts';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type Exact = Assert<Equal<Before, After>>;
export type Forward = Assert<Before extends After ? true : false>;
export type Reverse = Assert<After extends Before ? true : false>;
export type NoBytes = Assert<'bytes' extends keyof After ? false : true>;
`);
 const program=ts.createProgram([path.join(temp,'proof.ts')],{strict:true,noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,types:[]});
 const diagnostics=ts.getPreEmitDiagnostics(program);if(diagnostics.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>temp,getNewLine:()=> '\n'}));
 const record={typescriptVersion:ts.version,results,originalAliasText:originalAlias,movedAliasText:movedAlias,aliasTextIdentical:true,existingContractPrefixByteIdentical:true,actualRelevantDeclarationTypeEquality:{diagnostics:0,exact:true,bothDirections:true,bytesAbsent:true,scope:'original actual PreviewViewModel declaration extracted by AST and exact alias, original whole-contract prefix separately byte-checked; scoped type equality, no package/API stubs or full application qualification'},current54EvidenceNotRerun:true,originalRuntimeExecutionSha:'98dc5c4e01f57f3a52443b100d7e8e0df6c8059d',qualification:false};
 fs.writeFileSync(path.join(out,'equivalence.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({typescript:ts.version,runtimeEmissionFiles:3,aliasTextIdentical:true,wholeContractPrefixIdentical:true,typeEqualityDiagnostics:0}));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
