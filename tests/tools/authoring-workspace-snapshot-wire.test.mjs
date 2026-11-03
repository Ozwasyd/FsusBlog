import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const source=readFileSync(path.join(root,'src/frontend/src/codecs/binary/authoringWorkspaceSnapshotWire.generated.ts'),'utf8');
const wire=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const golden=JSON.parse(readFileSync(path.join(root,'tests/fixtures/protocol/authoring-workspace-snapshot-wire-golden.json'),'utf8'));
const bytes=name=>Buffer.from(golden.cases.find(item=>item.name===name).payloadHex,'hex');
const codec=frame=>frame===270?{decode:wire.decodeAuthoringWorkspaceSnapshotRequest,encode:wire.encodeAuthoringWorkspaceSnapshotRequest}:{decode:wire.decodeAuthoringWorkspaceSnapshotResponse,encode:wire.encodeAuthoringWorkspaceSnapshotResponse};
test('all independently produced typed golden bytes round trip or fail closed',()=>{
 assert.ok(golden.cases.length>40);
 for(const item of golden.cases){const {decode,encode}=codec(item.frameType);const payload=Buffer.from(item.payloadHex,'hex');if(item.valid)assert.deepEqual(Buffer.from(encode(decode(payload))),payload,item.name);else assert.throws(()=>decode(payload),undefined,item.name);}
});
test('zero/one/hundred tabs preserve reference-only layout and single ownership',()=>{
 for(const count of [0,1,100]){const value=wire.decodeAuthoringWorkspaceSnapshotRequest(bytes(`write-${count}`));assert.equal(value.layout.tabs.length,count);assert.equal(value.layout.groups.length,count>1?2:1);assert.equal(value.layout.groups.reduce((sum,group)=>sum+group.tabIds.length,0),count);assert.equal(value.layout.shell.outlineOpen,true,'Transport preserves actual source value; default qualification is independent');}
 const value=wire.decodeAuthoringWorkspaceSnapshotRequest(bytes('write-100'));value.layout.tabs.push(structuredClone(value.layout.tabs[0]));assert.throws(()=>wire.encodeAuthoringWorkspaceSnapshotRequest(value));
});
test('safe longs are numbers and reject precision loss, fractions and coercion',()=>{
 const request=wire.decodeAuthoringWorkspaceSnapshotRequest(bytes('request-max-safe'));assert.equal(request.expectedRevision,Number.MAX_SAFE_INTEGER-1);
 const response=wire.decodeAuthoringWorkspaceSnapshotResponse(bytes('response-safe-user-and-time'));assert.equal(response.receipt.scope.userId,Number.MAX_SAFE_INTEGER);assert.equal(response.snapshot.updatedAt,Number.MAX_SAFE_INTEGER);
 for(const expectedRevision of [Number.MAX_SAFE_INTEGER,1.1,-1,'7',Infinity,NaN])assert.throws(()=>wire.encodeAuthoringWorkspaceSnapshotRequest({...request,expectedRevision}));
});
test('closed commands prohibit scope authority, unknown properties and serialized layout fallback',()=>{
 const value=wire.decodeAuthoringWorkspaceSnapshotRequest(bytes('write-0'));
 for(const extension of [{scope:{userId:8,siteId:'site:other'}},{payload:'{}'},{extra:0}])assert.throws(()=>wire.encodeAuthoringWorkspaceSnapshotRequest({...value,...extension}));
 assert.throws(()=>wire.encodeAuthoringWorkspaceSnapshotRequest({...value,layout:'{}'}));
 const unknown=structuredClone(value);unknown.layout.shell.editorState='text';assert.throws(()=>wire.encodeAuthoringWorkspaceSnapshotRequest(unknown));
 assert.throws(()=>wire.encodeAuthoringWorkspaceSnapshotRequest({...value,sourceDigest:'A'.repeat(64)}));
});
test('every small request and response truncation plus payload budgets reject',()=>{
 for(const [frame,name] of [[270,'write-1'],[271,'current-1']]){const payload=bytes(name);for(let end=0;end<payload.length;end++)assert.throws(()=>codec(frame).decode(payload.subarray(0,end)));assert.throws(()=>codec(frame).decode(new Uint8Array(65537)));}
});
test('receipt association rejects stable identity, source, revision and count mismatches',()=>{
 const value=wire.decodeAuthoringWorkspaceSnapshotResponse(bytes('current-1'));
 for(const change of [{scope:{...value.receipt.scope,userId:8}},{sourceDigest:'b'.repeat(64)},{snapshotDigest:'b'.repeat(64)},{tabCount:0},{revisionAfter:8},{status:'missing'}])assert.throws(()=>wire.encodeAuthoringWorkspaceSnapshotResponse({...value,receipt:{...value.receipt,...change}}));
});
test('UTF8 and boolean encoding rejects malformed strings and coerced scalars',()=>{
 const value=wire.decodeAuthoringWorkspaceSnapshotResponse(bytes('blocked'));
 assert.throws(()=>wire.encodeAuthoringWorkspaceSnapshotResponse({...value,receipt:{...value.receipt,reason:'\ud800'}}));
 const write=wire.decodeAuthoringWorkspaceSnapshotRequest(bytes('write-1'));write.layout.tabs[0].isPreview=1;assert.throws(()=>wire.encodeAuthoringWorkspaceSnapshotRequest(write));
});
