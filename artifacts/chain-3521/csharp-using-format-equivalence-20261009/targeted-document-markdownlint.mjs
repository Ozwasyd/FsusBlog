import { lint } from "/workspace/chain-3521-evidence/source-docs-toolchain/node_modules/markdownlint/lib/exports-promise.mjs";
import { readFileSync } from "node:fs";
const configuration = JSON.parse(readFileSync(".markdownlint-cli2.jsonc", "utf8"));
const files = ["docs/development/change-contract.md"];
const result = await lint({ files, config: configuration.config,
    frontMatter: new RegExp(configuration.frontMatter, "u"),
    noInlineConfig: configuration.noInlineConfig, handleRuleFailures: true });
console.log(JSON.stringify({ kind: "targeted original markdownlint engine with unchanged repository rule options", files, result }));
process.exitCode = Object.values(result).some(errors => errors.length > 0) ? 1 : 0;
