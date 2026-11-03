import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const schema=JSON.parse(readFileSync(path.join(root,'src/shared/Contracts/Validation/authoring-workspace-snapshot-wire.json'),'utf8'));
const camel=s=>s[0].toLowerCase()+s.slice(1);
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const sourceDigest='a'.repeat(64);
const scope={userId:7,siteId:'site:local'};
function layout(count=0,twoGroups=false)
{
 const tabs=Array.from({length:count},(_,i)=>({tabId:`tab:${String(i).padStart(3,'0')}`,identity:{articleId:i===0?null:i+1,draftId:`draft:${String(i).padStart(3,'0')}`,documentId:`doc:${String(i).padStart(3,'0')}`},isPreview:i===0,isPinned:i!==0}));
 const groupA={groupId:'group:primary',tabIds:tabs.filter((_,i)=>!twoGroups||i%2===0).map(tab=>tab.tabId),activeTabId:count===0?null:'tab:000'};
 const groupB={groupId:'group:secondary',tabIds:tabs.filter((_,i)=>i%2===1).map(tab=>tab.tabId),activeTabId:count>1?'tab:001':null};
 return {tabs,groups:twoGroups?[groupA,groupB]:[groupA],activeGroupId:'group:primary',splitRatioPermille:500,shell:{libraryOpen:true,libraryView:'all',outlineOpen:true,inspectorOpen:false,inspectorView:'publish'}};
}
function response(status,count=0,action=status==='applied'?'write':'read')
{
 const present=status==='current'||status==='applied';const revision=status==='missing'?0:7;
 let snapshot=null;
 if(present){snapshot={schemaVersion:1,workspaceId:'default',scope:{...scope},sourceContract:'fsusblog.authoring-workspace-snapshot.v1',sourceDigest,revision,updatedAt:1791417600000,layout:layout(count,count>1)};snapshot.contentDigest=digest(snapshot);}
 const receipt={schema:'fsusblog.authoring-workspace-snapshot-receipt.v1',action,status,reason:status==='blocked'?'corrupt':status==='conflict'?'stale_revision':null,scope:{...scope},workspaceId:'default',sourceDigest,revisionBefore:status==='applied'?revision-1:revision,revisionAfter:revision,tabCount:count,byteCount:snapshot?Buffer.byteLength(canonical(snapshot)):0,inputDigest:digest(scope),snapshotDigest:snapshot?.contentDigest??null,contentDigest:''};
 receipt.contentDigest=digest(receipt);
 return {status,revision,snapshot,receipt};
}
function encode(name,value)
{
 const bytes=[Buffer.from([1])];
 function i32(value){const bytes4=Buffer.alloc(4);bytes4.writeInt32LE(value);bytes.push(bytes4);}
 function scalar(field,value){if(field.type==='bool')bytes.push(Buffer.from([value?1:0]));else if(field.type==='int32')i32(value);else if(field.type==='int64'){const bytes8=Buffer.alloc(8);bytes8.writeBigInt64LE(BigInt(value));bytes.push(bytes8);}else if(field.type==='string'){if(field.values)bytes.push(Buffer.from([field.values.indexOf(value)]));else {const utf8=Buffer.from(value);i32(utf8.length);bytes.push(utf8);}}else record(field.type,value);}
 function record(name,value){for(const field of schema.records[name].fields){const item=value[camel(field.name)];if(field.array){i32(item.length);for(const element of item)scalar(field,element);}else if(field.nullable){bytes.push(Buffer.from([item===null?0:1]));if(item!==null)scalar(field,item);}else scalar(field,item);}}
 record(name,value);return Buffer.concat(bytes);
}
const cases=[];
function add(name,type,value,valid=true){cases.push({name,frameType:schema.roots[type],valid,payloadHex:encode(type,value).toString('hex')});}
const request=(count=0)=>({action:'write',expectedRevision:0,sourceDigest,layout:layout(count,count>1),resetConfirmationDigest:null});
for(const count of [0,1,100])add(`write-${count}`,'AuthoringWorkspaceSnapshotRequest',request(count));
add('reset','AuthoringWorkspaceSnapshotRequest',{action:'reset',expectedRevision:7,sourceDigest,layout:null,resetConfirmationDigest:'b'.repeat(64)});
for(const count of [0,1,100])add(`current-${count}`,'AuthoringWorkspaceSnapshotResponse',response('current',count));
for(const status of ['missing','blocked','conflict','applied'])add(status,'AuthoringWorkspaceSnapshotResponse',response(status,0,status==='conflict'?'write':undefined));
const safe=request();safe.expectedRevision=9007199254740990;add('request-max-safe','AuthoringWorkspaceSnapshotRequest',safe);
const valid=response('current',1);valid.receipt.scope.userId=9007199254740991;valid.snapshot.scope.userId=9007199254740991;valid.snapshot.updatedAt=9007199254740991;delete valid.snapshot.contentDigest;valid.snapshot.contentDigest=digest(valid.snapshot);valid.receipt.snapshotDigest=valid.snapshot.contentDigest;valid.receipt.byteCount=Buffer.byteLength(canonical(valid.snapshot));valid.receipt.contentDigest='';valid.receipt.contentDigest=digest(valid.receipt);add('response-safe-user-and-time','AuthoringWorkspaceSnapshotResponse',valid);
function badRequest(name,mutate){const value=request(2);mutate(value);add(name,'AuthoringWorkspaceSnapshotRequest',value,false);}
badRequest('duplicate-tab',v=>v.layout.tabs[1].tabId=v.layout.tabs[0].tabId);
badRequest('duplicate-draft',v=>v.layout.tabs[1].identity.draftId=v.layout.tabs[0].identity.draftId);
badRequest('duplicate-document',v=>v.layout.tabs[1].identity.documentId=v.layout.tabs[0].identity.documentId);
badRequest('duplicate-article',v=>v.layout.tabs[0].identity.articleId=v.layout.tabs[1].identity.articleId);
badRequest('preview-pinned-equal',v=>v.layout.tabs[0].isPinned=true);
badRequest('two-previews',v=>{v.layout.groups=[{groupId:'group:primary',tabIds:v.layout.tabs.map(t=>t.tabId),activeTabId:'tab:000'}];v.layout.tabs[1].isPreview=true;v.layout.tabs[1].isPinned=false;});
badRequest('mirrored-tab',v=>v.layout.groups[1].tabIds=['tab:000']);
badRequest('orphan-tab',v=>{v.layout.groups[1].tabIds=[];v.layout.groups[1].activeTabId=null;});
badRequest('unknown-active-group',v=>v.layout.activeGroupId='group:absent');
badRequest('unknown-active-tab',v=>v.layout.groups[0].activeTabId='tab:absent');
badRequest('duplicate-group',v=>v.layout.groups[1].groupId='group:primary');
badRequest('split-range',v=>v.layout.splitRatioPermille=199);
badRequest('unknown-library-view',v=>v.layout.shell.libraryView='json');
badRequest('unknown-inspector-view',v=>v.layout.shell.inspectorView='json');
badRequest('write-with-confirmation',v=>v.resetConfirmationDigest='b'.repeat(64));
badRequest('reset-with-layout',v=>v.action='reset');
badRequest('reset-missing-confirmation',v=>{v.action='reset';v.layout=null;});
badRequest('write-missing-layout',v=>v.layout=null);
badRequest('empty-group-active-tab',v=>{v.layout.groups[1].tabIds=[];});
badRequest('unknown-group-tab',v=>v.layout.groups[1].tabIds=['tab:absent']);
badRequest('source-digest-case',v=>v.sourceDigest='A'.repeat(64));
badRequest('unsafe-revision',v=>v.expectedRevision=9007199254740991);
for(const field of ['status','revision','snapshotDigest','scope','sourceDigest','tabCount']){
 const value=response('current',1);if(field==='status')value.receipt.status='blocked';if(field==='revision')value.receipt.revisionAfter++;if(field==='snapshotDigest')value.receipt.snapshotDigest='b'.repeat(64);if(field==='scope')value.receipt.scope.userId++;if(field==='sourceDigest')value.receipt.sourceDigest='b'.repeat(64);if(field==='tabCount')value.receipt.tabCount++;add(`receipt-${field}-binding`,'AuthoringWorkspaceSnapshotResponse',value,false);
}
function raw(name,base,mutate){const original=cases.find(c=>c.name===base);let bytes=Buffer.from(original.payloadHex,'hex');bytes=mutate(bytes)??bytes;cases.push({name,frameType:original.frameType,valid:false,payloadHex:bytes.toString('hex')});}
raw('future-version','write-0',b=>{b[0]=2;});raw('unknown-action','write-0',b=>{b[1]=255;});raw('unknown-status','missing',b=>{b[1]=255;});raw('unknown-layout-presence','write-0',b=>{b[78]=2;});raw('count-101','write-0',b=>{b.writeInt32LE(101,79);});raw('negative-count','write-0',b=>{b.writeInt32LE(-1,79);});raw('malformed-utf8','write-1',b=>{b[b.indexOf(Buffer.from('draft:000'))]=255;});raw('invalid-tab-boolean','write-1',b=>{b[b.indexOf(Buffer.from('doc:000'))+7]=2;});raw('trailing-byte','write-0',b=>Buffer.concat([b,Buffer.from([0])]));raw('truncated','current-1',b=>b.subarray(0,b.length-1));
const output=JSON.stringify({schemaVersion:1,producer:'tools/contracts/generate-authoring-workspace-snapshot-golden.mjs',qualification:'Typed binary shape/parity only; no authentication, receipt qualification or runtime acceptance.',cases},null,2)+'\n';
const file=path.join(root,'tests/fixtures/protocol/authoring-workspace-snapshot-wire-golden.json');
if(process.argv.includes('--check')){if(readFileSync(file,'utf8')!==output){console.error('stale workspace snapshot golden');process.exitCode=1;}}else writeFileSync(file,output);
