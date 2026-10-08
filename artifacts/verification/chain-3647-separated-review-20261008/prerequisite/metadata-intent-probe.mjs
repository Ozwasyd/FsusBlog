import fs from 'node:fs';
import {changedFilesBetween,validatePrContract,validateRepositoryBlameIgnore,validateRepositorySources} from '/tmp/fsusblog-3647-master-aaba/tools/governance/change-contract.mjs';
import {checkCodeIntent} from '/tmp/fsusblog-3647-master-aaba/tools/governance/check-code-intent.mjs';
const root="/workspace/FsusBlog-3647-prerequisites",base="aaba7b8c84ecfb336c71443e30d9fd82d21fb16d",head="4fde8307d43ca8ee1b38cf71fbde3786f6ae46f5",changedFiles=changedFilesBetween(root,base,head);
const errors=[...validatePrContract({title:"test(backend): review canonical projection verification adaptations",body:fs.readFileSync("/workspace/fsusblog-3647-scoped-verification/prerequisite/pr-body-local.md",'utf8'),labels:['release-note:internal'],actor:null,changedFiles,root,base,head,authorityRoot:"/tmp/fsusblog-3647-master-aaba"}),...validateRepositoryBlameIgnore(root),...validateRepositorySources(root)];
const intent=checkCodeIntent({root,files:changedFiles});
console.log(JSON.stringify({scope:'trusted exact-base prospective local PR metadata and complete-diff scoped intent; not actual GitHub PR admission or global intent qualification',base,head,changedFiles,errors,intent},null,2));process.exitCode=errors.length||intent.errors.length?1:0;
