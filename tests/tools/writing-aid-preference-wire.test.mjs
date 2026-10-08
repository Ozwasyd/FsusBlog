import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const source=readFileSync(path.join(root,'src/frontend/src/codecs/binary/writingAidPreferenceWire.generated.ts'),'utf8');
const wire=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const golden=JSON.parse(readFileSync(path.join(root,'tests/fixtures/protocol/writing-aid-preference-wire-golden.json'),'utf8'));
const item=name=>golden.cases.find(row=>row.name===name);
const bytes=name=>Buffer.from(item(name).payloadHex,'hex');
const codec=frame=>frame===272?{decode:wire.decodeWritingAidPreferenceSnapshot,encode:wire.encodeWritingAidPreferenceSnapshot}:frame===273?{decode:wire.decodeWritingAidPreferenceUpdateRequest,encode:wire.encodeWritingAidPreferenceUpdateRequest}:{decode:wire.decodeWritingAidPreferenceReceipt,encode:wire.encodeWritingAidPreferenceReceipt};
test('all independent POD/domain/receipt golden cases retain exact bytes or fail closed',()=>{
 assert.equal(golden.cases.length,106);
 for(const row of golden.cases){const c=codec(row.frameType);const payload=Buffer.from(row.payloadHex,'hex');if(row.valid)assert.deepEqual(Buffer.from(c.encode(c.decode(payload,row.expectedOwner))),payload,row.name);else assert.throws(()=>c.decode(payload,row.expectedOwner),undefined,row.name);}
});
test('original upstream 96-byte Snapshot and 80-byte Update ABI remains exact',()=>{
 const snapshot=wire.decodeWritingAidPreferenceSnapshot(bytes('snapshot-values-5'));assert.equal(snapshot.contentDigest,'4a979bb470024e92faf123866eac6809e60d1c93b7ad25dd83469a3a6f91a5bc');assert.equal(bytes('snapshot-values-5').length,119);assert.equal(bytes('update-values-5').length,80);
 for(let mask=0;mask<8;mask++){const s=wire.decodeWritingAidPreferenceSnapshot(bytes(`snapshot-values-${mask}`));assert.equal(s.values.focusEnabled,!!(mask&1));assert.equal(s.values.typewriterEnabled,!!(mask&2));assert.equal(s.values.immersiveEnabled,!!(mask&4));}
});
test('every truncation and every Snapshot or Receipt single-byte bit substitution refuses',()=>{
 for(const name of ['snapshot-values-5','update-values-5','receipt-values-5']){const row=item(name),payload=bytes(name),c=codec(row.frameType);for(let end=0;end<payload.length;end++)assert.throws(()=>c.decode(payload.subarray(0,end),row.expectedOwner),undefined,`${name}:${end}`);if(row.frameType!==273)for(let offset=0;offset<payload.length;offset++){const mutation=Buffer.from(payload);mutation[offset]^=1;assert.throws(()=>c.decode(mutation,row.expectedOwner),undefined,`${name}:mutation:${offset}`);}}
});
test('authenticated owner coordinates are only an explicit external expected value, never inferred actor',()=>{
 const row=item('snapshot-values-5');for(const expectedOwner of [{userScope:'account:43',siteScope:'site:test'},{userScope:'admin:42',siteScope:'site:test'},{userScope:'account:42',siteScope:'site:other'}]){assert.throws(()=>wire.decodeWritingAidPreferenceSnapshot(bytes(row.name),expectedOwner));assert.throws(()=>wire.decodeWritingAidPreferenceReceipt(bytes('receipt-values-5'),expectedOwner));}
});
test('write command has no owner/device authority and rejects unknown keys, coercion or JSON fallback',()=>{
 const value=wire.decodeWritingAidPreferenceUpdateRequest(bytes('update-values-5'));
 for(const extra of [{owner:{userScope:'account:42',siteScope:'site:test'}},{deviceScope:'device:'+'a'.repeat(64)},{extra:true}])assert.throws(()=>wire.encodeWritingAidPreferenceUpdateRequest({...value,...extra}));
 for(const expectedRevision of [-1,1.5,Number.MAX_SAFE_INTEGER,'7',NaN,Infinity])assert.throws(()=>wire.encodeWritingAidPreferenceUpdateRequest({...value,expectedRevision}));
 assert.throws(()=>wire.encodeWritingAidPreferenceUpdateRequest({...value,values:'{}'}));assert.throws(()=>wire.encodeWritingAidPreferenceUpdateRequest({...value,values:{...value.values,focusEnabled:1}}));assert.throws(()=>wire.encodeWritingAidPreferenceUpdateRequest({...value,operationId:value.operationId.toUpperCase()}));
});
test('real digests and initialize revision/default transition checks apply before encoding',()=>{
 const value=wire.decodeWritingAidPreferenceReceipt(bytes('receipt-initialize'));
 for(const change of [{action:'migrate-legacy'},{status:'replayed'},{contentDigest:'0'.repeat(64)},{deviceScope:'device:'+'A'.repeat(64)}])assert.throws(()=>wire.encodeWritingAidPreferenceReceipt({...value,...change}));
 assert.throws(()=>wire.encodeWritingAidPreferenceReceipt({...value,previous:{...value.previous,revision:7}}));assert.throws(()=>wire.encodeWritingAidPreferenceReceipt({...value,committed:{...value.committed,values:{...value.committed.values,focusEnabled:true}}}));
});
test('bounded exact UTF8/UTF16 and cross-language escape-sensitive vectors preserve scope',()=>{
 for(const name of ['site-unicode','site-maximum-utf16','site-html-sensitive','site-bom-not-whitespace','site-all-printable-ascii']){const row=item(`snapshot-${name}`);const value=wire.decodeWritingAidPreferenceSnapshot(bytes(row.name),row.expectedOwner);assert.deepEqual(value.owner,row.expectedOwner);assert.deepEqual(Buffer.from(wire.encodeWritingAidPreferenceSnapshot(value)),bytes(row.name));}
 const value=wire.decodeWritingAidPreferenceSnapshot(bytes('snapshot-values-5'));for(const siteScope of ['site:\ud800','site:\udfff','\u0085site:test','site:test\u2000','site:\u007f','x'.repeat(129)])assert.throws(()=>wire.encodeWritingAidPreferenceSnapshot({...value,owner:{...value.owner,siteScope}}));
});
test('both sole family producers detect current source/output drift',()=>{
 for(const file of ['tools/contracts/generate-writing-aid-preference-wire.mjs','tools/contracts/generate-writing-aid-preference-golden.mjs']){const result=spawnSync(process.execPath,[file,'--check'],{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);}
});
test('actual private native decoder agrees on all goldens and rejects unknown family, then removes temporary build',()=>{
 const rows=golden.cases.map(row=>`${row.frameType} ${Number(row.valid)} ${row.payloadHex||'-'}`);
 for(const name of ['snapshot-values-5','update-values-5','receipt-values-5']){const row=item(name),payload=bytes(name);for(let end=0;end<payload.length;end++)rows.push(`${row.frameType} 0 ${payload.subarray(0,end).toString('hex')||'-'}`);if(row.frameType!==273)for(let offset=0;offset<payload.length;offset++){const mutation=Buffer.from(payload);mutation[offset]^=1;rows.push(`${row.frameType} 0 ${mutation.toString('hex')}`);}}
 rows.push('271 0 -','275 0 -','65535 0 -');
 const directory=mkdtempSync(path.join(tmpdir(),'fsus-writing-aid-wire-'));let removed=false;
 try{
  const runner=path.join(directory,'main.cpp');writeFileSync(runner,`#include "writing_aid_preference_wire.generated.hpp"\n#include <iostream>\nint main(){unsigned frame,valid;std::string hex;int count=0;while(std::cin>>frame>>valid>>hex){std::vector<std::uint8_t> bytes;if(hex!="-"){if(hex.size()%2)return 2;for(std::size_t i=0;i<hex.size();i+=2){auto nibble=[](char c)->int{if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;};int a=nibble(hex[i]),b=nibble(hex[i+1]);if(a<0||b<0)return 3;bytes.push_back((a<<4)|b);}}bool actual=FsusBlog::Aeds::ValidateWritingAidPreferencePayload(frame,bytes.data(),bytes.size());if(actual!=(valid==1)){std::cerr<<"case:"<<count<<" frame:"<<frame<<" expected:"<<valid<<" actual:"<<actual<<"\\n";return 4;}count++;}if(count!=${rows.length})return 5;std::cout<<"native:"<<count<<" cases\\n";return 0;}\n`);
  const executable=path.join(directory,'fixture');const build=spawnSync('g++',['-std=c++23','-Wall','-Wextra','-Werror','-I',path.join(root,'src/frontend/wasm/aeds/include'),runner,'-o',executable],{encoding:'utf8'});assert.equal(build.status,0,build.stdout+build.stderr);
  const input=rows.join('\n')+'\n';const run=spawnSync(executable,[],{input,encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(run.stdout.trim(),`native:${rows.length} cases`);
 }finally{rmSync(directory,{recursive:true,force:true});removed=!existsSync(directory);}assert.equal(removed,true);
});
function frame(type,payload){
 const output=Buffer.alloc(16+payload.length);output.writeUInt32LE(0x53444541,0);output[4]=2;output[5]=16;output.writeUInt16LE(type,8);output.writeUInt32LE(payload.length,10);let crc=0xffff;for(const byte of payload){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc&1)?(crc>>>1)^0xa001:crc>>>1;}output.writeUInt16LE(crc,14);payload.copy(output,16);return output;
}
test('production DecodeFrame preserves exact AEDS2 header/CRC/errors and writing-aid error15',()=>{
 const rows=golden.cases.map(row=>`${row.valid?0:15} ${frame(row.frameType,Buffer.from(row.payloadHex,'hex')).toString('hex')}`);
 for(const name of ['snapshot-values-5','update-values-5','receipt-values-5']){const row=item(name),payload=bytes(name);for(let end=0;end<payload.length;end++)rows.push(`15 ${frame(row.frameType,payload.subarray(0,end)).toString('hex')}`);if(row.frameType!==273)for(let offset=0;offset<payload.length;offset++){const mutation=Buffer.from(payload);mutation[offset]^=1;rows.push(`15 ${frame(row.frameType,mutation).toString('hex')}`);}}
 const valid=frame(272,bytes('snapshot-values-5'));
 for(const [offset,value,error] of [[0,0,2],[4,1,4],[5,0,5],[10,0,3],[14,valid[14]^1,6]]){const bad=Buffer.from(valid);bad[offset]=value;rows.push(`${error} ${bad.toString('hex')}`);}
 rows.push('1 -',`3 ${valid.subarray(0,valid.length-1).toString('hex')}`,`16 ${frame(275,Buffer.alloc(0)).toString('hex')}`,`8 ${frame(65534,Buffer.alloc(0)).toString('hex')}`,`8 ${frame(65535,Buffer.alloc(0)).toString('hex')}`,`9 ${frame(186,Buffer.alloc(0)).toString('hex')}`,`10 ${frame(244,Buffer.alloc(0)).toString('hex')}`,`13 ${frame(269,Buffer.alloc(0)).toString('hex')}`,`14 ${frame(270,Buffer.alloc(0)).toString('hex')}`);
 const directory=mkdtempSync(path.join(tmpdir(),'fsus-writing-aid-production-'));
 try{
  const input=path.join(directory,'cases.txt'),executable=path.join(directory,'fixture');writeFileSync(input,rows.join('\n')+'\n');
  const build=spawnSync(process.env.CXX??'g++',['-std=c++23','-Wall','-Wextra','-Werror','-I',path.join(root,'src/frontend/wasm/aeds/include'),path.join(root,'tests/fixtures/protocol/writing-aid-preference-wire-native.cpp'),...['aeds_decode.cpp','aeds_crc32.cpp','pod_parse_article.cpp'].map(name=>path.join(root,'src/frontend/wasm/aeds/src',name)),'-o',executable],{encoding:'utf8'});assert.equal(build.status,0,build.stdout+build.stderr);
  const run=spawnSync(executable,[input,String(rows.length)],{encoding:'utf8'});assert.equal(run.status,0,run.stdout+run.stderr);assert.equal(run.stdout.trim(),`production dispatcher=${rows.length} cases, error15 and borrowed views verified`);
  assert.equal(spawnSync(executable,[input,String(rows.length+1)]).status,4);for(const count of ['0','1extra'])assert.equal(spawnSync(executable,[input,count]).status,2);
  for(const malformed of ['0 0\n','0 gg\n','18 00\n','0 00 extra\n']){const file=path.join(directory,'malformed.txt');writeFileSync(file,malformed);assert.equal(spawnSync(executable,[file,'1']).status,2);}
 }finally{rmSync(directory,{recursive:true,force:true});assert.equal(existsSync(directory),false);}
});
