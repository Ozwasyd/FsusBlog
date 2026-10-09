import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const schema=JSON.parse(readFileSync(path.join(root,'src/shared/Contracts/Validation/writing-aid-preference-wire.json'),'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
for(const input of schema.owners)if(sha(readFileSync(path.join(root,input.path)))!==input.sha256)throw new Error(`writing_aid_golden_owner_drift:${input.path}`);
const operation='01234567-89ab-cdef-0123-456789abcdef';
const device='device:'+'a'.repeat(64);
const owner={userScope:'account:42',siteScope:'site:test'};
const values=mask=>({schemaVersion:1,focusEnabled:(mask&1)!==0,typewriterEnabled:(mask&2)!==0,immersiveEnabled:(mask&4)!==0});
function quoted(value){let text='"';for(let i=0;i<value.length;i++){const code=value.charCodeAt(i);if(code===92)text+='\\\\';else if(code<32||code>126||[34,38,39,43,60,62,96].includes(code))text+='\\u'+code.toString(16).toUpperCase().padStart(4,'0');else text+=value[i];}return text+'"';}
function snapshot(mask=0,revision=1,scope=owner){const value={owner:scope,revision,values:values(mask),contentDigest:''};value.contentDigest=sha('['+[quoted('fsusblog.writing-aid-preference.v1'),quoted(scope.userScope),quoted(scope.siteScope),String(revision),'1',String(value.values.focusEnabled),String(value.values.typewriterEnabled),String(value.values.immersiveEnabled)].join(',')+']');return value;}
function receipt(previous,committed,action='update'){const value={operationId:operation,deviceScope:device,previous,committed,action,status:'committed',contentDigest:''};value.contentDigest=sha('['+[quoted('fsusblog.writing-aid-receipt.v1'),quoted(operation),quoted(device),quoted(previous.contentDigest),quoted(committed.contentDigest),quoted(action),quoted('committed')].join(',')+']');return value;}
function encodeSnapshot(value){const user=Buffer.from(value.owner.userScope);const site=Buffer.from(value.owner.siteScope);const output=Buffer.alloc(100+user.length+site.length);output.writeInt32LE(value.values.schemaVersion,0);output[4]=Number(value.values.focusEnabled);output[5]=Number(value.values.typewriterEnabled);output[6]=Number(value.values.immersiveEnabled);output.writeBigInt64LE(BigInt(value.revision),8);output.writeInt32LE(user.length,20);output.writeInt32LE(user.length,24);output.writeInt32LE(site.length,28);output.write(value.contentDigest,32,64,'utf8');output.writeInt32LE(user.length+site.length,96);user.copy(output,100);site.copy(output,100+user.length);return output;}
function encodeUpdate(mask=0,revision=7,op=operation){const output=Buffer.alloc(80);output.writeBigInt64LE(BigInt(revision),0);output.writeInt32LE(1,8);output[12]=Number(mask&1);output[13]=Number((mask>>1)&1);output[14]=Number((mask>>2)&1);output.write(op,16,36,'utf8');return output;}
function encodeReceipt(value){const previous=encodeSnapshot(value.previous),committed=encodeSnapshot(value.committed);const output=Buffer.alloc(210+previous.length+committed.length);output[0]=1;output.write(value.operationId,1,36,'utf8');output.write(value.deviceScope,65,71,'utf8');output[136]=value.action==='update'?0:value.action==='initialize'?1:2;output[137]=0;output.writeInt32LE(previous.length,138);previous.copy(output,142);let offset=142+previous.length;output.writeInt32LE(committed.length,offset);offset+=4;committed.copy(output,offset);offset+=committed.length;output.write(value.contentDigest,offset,64,'utf8');return output;}
const cases=[];function add(name,frameType,bytes,valid=true,expectedOwner=owner){cases.push({name,frameType,valid,expectedOwner,payloadHex:bytes.toString('hex')});}
const mutate=(bytes,offset,value)=>{const output=Buffer.from(bytes);output[offset]=value;return output;};
const write32=(bytes,offset,value)=>{const output=Buffer.from(bytes);output.writeInt32LE(value,offset);return output;};
const write64=(bytes,offset,value)=>{const output=Buffer.from(bytes);output.writeBigInt64LE(BigInt(value),offset);return output;};
for(let mask=0;mask<8;mask++){add(`snapshot-values-${mask}`,272,encodeSnapshot(snapshot(mask,7)));add(`update-values-${mask}`,273,encodeUpdate(mask));add(`receipt-values-${mask}`,274,encodeReceipt(receipt(snapshot(0,7),snapshot(mask,8))));}
add('snapshot-defaults-zero',272,encodeSnapshot(snapshot(0,0)));
add('snapshot-maximum-revision',272,encodeSnapshot(snapshot(7,Number.MAX_SAFE_INTEGER)));
add('update-maximum-cas',273,encodeUpdate(7,Number.MAX_SAFE_INTEGER-1));
add('receipt-initialize',274,encodeReceipt(receipt(snapshot(0,0),snapshot(0,1),'initialize')));
add('receipt-maximum-revision',274,encodeReceipt(receipt(snapshot(7,Number.MAX_SAFE_INTEGER-1),snapshot(5,Number.MAX_SAFE_INTEGER))));
for(const [name,scope] of [
 ['maximum-user',{userScope:'admin:9007199254740991',siteScope:'site:test'}],
 ['site-unicode',{userScope:'account:42',siteScope:'site:界😀é'}],
 ['site-maximum-utf16',{userScope:'account:42',siteScope:'site:'+'界'.repeat(123)}],
 ['site-html-sensitive',{userScope:'account:42',siteScope:'site:<>&\'"+`\\/'}],
 ['site-bom-not-whitespace',{userScope:'account:42',siteScope:'\uFEFFsite:valid\uFEFF'}],
 ['site-all-printable-ascii',{userScope:'account:42',siteScope:'site:'+Array.from({length:95},(_,i)=>String.fromCharCode(32+i)).join('')}],
 ]){add(`snapshot-${name}`,272,encodeSnapshot(snapshot(5,7,scope)),true,scope);add(`receipt-${name}`,274,encodeReceipt(receipt(snapshot(0,7,scope),snapshot(5,8,scope))),true,scope);}
const s=encodeSnapshot(snapshot(5,7));const u=encodeUpdate(5);const r=encodeReceipt(receipt(snapshot(0,7),snapshot(5,8)));
if(snapshot(5,7).contentDigest!=='4a979bb470024e92faf123866eac6809e60d1c93b7ad25dd83469a3a6f91a5bc')throw new Error('original_snapshot_reference_drift');
for(const [name,offset,value] of [['schema',0,2],['focus',4,2],['typewriter',5,2],['immersive',6,2],['reserved',7,1],['digest-tampered',32,53],['digest-uppercase',32,65],['invalid-utf8',100,255]])add(`snapshot-invalid-${name}`,272,mutate(s,offset,value),false);
for(const [name,offset,value] of [['negative-revision',8,-1n],['unsafe-revision',8,9007199254740992n]])add(`snapshot-invalid-${name}`,272,write64(s,offset,value),false);
for(const [name,offset,value] of [['user-offset',16,1],['user-empty',20,0],['site-offset',24,0],['site-length',28,2],['blob-negative',96,-1],['blob-empty',96,0],['blob-overflow',96,2147483647],['blob-oversized',96,513]])add(`snapshot-invalid-${name}`,272,write32(s,offset,value),false);
add('snapshot-invalid-zero-nondefaults',272,encodeSnapshot(snapshot(1,0)),false);
for(const [name,scope] of [['user-leading-zero',{...owner,userScope:'account:042'}],['user-unknown-prefix',{...owner,userScope:'guest:42'}],['site-leading-unicode-whitespace',{...owner,siteScope:'\u0085site:test'}],['site-trailing-unicode-whitespace',{...owner,siteScope:'site:test\u2000'}],['site-control',{...owner,siteScope:'site:\u007F'}],['site-length-129',{...owner,siteScope:'x'.repeat(129)}]])add(`snapshot-invalid-${name}`,272,encodeSnapshot(snapshot(5,7,scope)),false);
for(const [name,offset,value] of [['schema',8,2],['focus',12,2],['typewriter',13,2],['immersive',14,2],['reserved',15,1],['uuid-uppercase',16,65],['uuid-dash',24,97],['uuid-invalid-utf8',16,255],['uuid-padding',52,1]])add(`update-invalid-${name}`,273,mutate(u,offset,value),false);
for(const [name,value] of [['negative',-1n],['cas-exhausted',9007199254740991n],['unsafe',9007199254740992n]])add(`update-invalid-revision-${name}`,273,write64(u,0,value),false);
add('update-invalid-empty-uuid',273,encodeUpdate(0,0,'00000000-0000-0000-0000-000000000000'),false);
for(const [name,offset,value] of [['version',0,2],['uuid-uppercase',1,65],['uuid-padding',37,1],['device-prefix',65,97],['device-digest-uppercase',72,65],['action-unknown',136,2],['status-unknown',137,1],['nested-digest-tampered',174,53],['receipt-digest-tampered',r.length-64,48]])add(`receipt-invalid-${name}`,274,mutate(r,offset,value),false);
for(const [name,value] of [['negative',-1],['empty',0],['oversized',613],['overflow',2147483647]])add(`receipt-invalid-nested-length-${name}`,274,write32(r,138,value),false);
add('receipt-invalid-cross-owner',274,encodeReceipt(receipt(snapshot(0,7),snapshot(5,8,{...owner,userScope:'account:43'}))),false);
add('receipt-invalid-cross-site',274,encodeReceipt(receipt(snapshot(0,7),snapshot(5,8,{...owner,siteScope:'site:other'}))),false);
add('receipt-invalid-revision-gap',274,encodeReceipt(receipt(snapshot(0,7),snapshot(5,9))),false);
add('receipt-invalid-initialize-nonzero',274,encodeReceipt(receipt(snapshot(0,7),snapshot(0,8),'initialize')),false);
add('receipt-invalid-initialize-nondefaults',274,encodeReceipt(receipt(snapshot(0,0),snapshot(1,1),'initialize')),false);
for(const [frameType,name,bytes] of [[272,'snapshot',s],[273,'update',u],[274,'receipt',r]]){add(`${name}-invalid-empty`,frameType,Buffer.alloc(0),false);add(`${name}-invalid-truncated`,frameType,bytes.subarray(0,bytes.length-1),false);add(`${name}-invalid-extra-bytes`,frameType,Buffer.concat([bytes,Buffer.from([0])]),false);}
const output={producer:'tools/contracts/generate-writing-aid-preference-golden.mjs',sourceOwnerCommit:schema.sourceOwnerCommit,sourceOwnerFiles:schema.owners,payloadOnly:true,noAuthenticationOrPersistenceReceipt:true,cases};
const serialized=JSON.stringify(output,null,2)+'\n';const target=path.join(root,'tests/fixtures/protocol/writing-aid-preference-wire-golden.json');
if(process.argv.includes('--check')){if(readFileSync(target,'utf8')!==serialized)throw new Error('writing_aid_golden_drift');}else writeFileSync(target,serialized);
console.log(JSON.stringify({mode:process.argv.includes('--check')?'check':'generate',cases:cases.length,valid:cases.filter(row=>row.valid).length,malformed:cases.filter(row=>!row.valid).length,sha256:sha(serialized)}));
