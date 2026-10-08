import fs from 'node:fs';
import {changedFilesBetween,validatePrContract,validateRepositoryBlameIgnore,validateRepositorySources} from '/workspace/FsusBlog-3647-prerequisites/tools/governance/change-contract.mjs';
import {checkCodeIntent} from '/workspace/FsusBlog-3647-prerequisites/tools/governance/check-code-intent.mjs';
const root="/workspace/FsusBlog-3647-docs-only",base="4fde8307d43ca8ee1b38cf71fbde3786f6ae46f5",head="7288b3b0e0211b2c0fa0531ab01e657e4f5e57c2",changedFiles=changedFilesBetween(root,base,head);
const errors=[...validatePrContract({title:"chore(security): clarify missing ban authority documentation",body:fs.readFileSync("/workspace/fsusblog-3647-scoped-verification/docs/pr-body-local.md",'utf8'),labels:['release-note:internal'],actor:null,changedFiles,root,base,head,authorityRoot:"/workspace/FsusBlog-3647-prerequisites"}),...validateRepositoryBlameIgnore(root),...validateRepositorySources(root)];
const intent=checkCodeIntent({root,files:changedFiles});
console.log(JSON.stringify({scope:'trusted exact-base prospective local PR metadata and complete-diff scoped intent; not actual GitHub PR admission or global intent qualification',base,head,changedFiles,errors,intent},null,2));process.exitCode=errors.length||intent.errors.length?1:0;
