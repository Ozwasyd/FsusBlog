from pathlib import Path
import json,re,collections
p=Path('/workspace/chain-1975-evidence/preack-abort-binding-20261010')
header=re.compile(r'^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$')
def diagnostics(label):
 blocks=[]
 for line in (p/(label+'.log')).read_text().splitlines():
  match=header.match(line)
  if match:
   path,code,message=match.groups()
   path=path.replace('/workspace/chain1975-runtime-attempt-borrow/','<blog>/').replace('/workspace/chain1975-runtime-borrow-type-baseline/','<blog>/')
   blocks.append(path+': '+code+': '+message)
  elif blocks and line.startswith(' '):blocks[-1]+='\n'+line
 return collections.Counter(blocks)
a=diagnostics('types-current');b=diagnostics('types-baseline')
r={'currentSource':json.loads((p/'types-current.json').read_text())['head'],'baselineSource':json.loads((p/'types-baseline.json').read_text())['head'],'currentCommandRecord':'types-current.json','baselineCommandRecord':'types-baseline.json','currentExit':2,'baselineExit':2,'currentCount':sum(a.values()),'baselineCount':sum(b.values()),'added':list((a-b).elements()),'removed':list((b-a).elements()),'fullTypecheckPassed':False,'qualification':False}
(p/'application-type-delta.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r));assert sum(a.values())==sum(b.values())==244 and a==b
