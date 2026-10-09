import { validateFormatOnlyDiff } from "/workspace/FsusBlog-csharp-using-format-equivalence/tools/governance/change-contract.mjs";
import { execFileSync } from "node:child_process";
const root = "/workspace/FsusBlog-csharp-using-format-equivalence";
const base = "020274069153c92725c7c9e5231c88b3415ff6ee";
const head = "afae0e36e48955e560a24b8653fde93f861da577";
const paths = execFileSync("git", ["diff", "--name-only", base, head], { cwd: root, encoding: "utf8" }).trim().split("\n");
const errors = validateFormatOnlyDiff(root, base, head);
console.log(JSON.stringify({ kind: "original format-only diff API observation, not PR or runtime acceptance", base, head, paths, errors }));
process.exitCode = errors.length > 0 ? 1 : 0;
