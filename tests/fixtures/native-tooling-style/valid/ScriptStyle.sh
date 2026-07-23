#!/usr/bin/env bash
set -Eeuo pipefail

PrintValue()
{
    local sampleValue="${1:?value is required}"
    export FSUSBLOG_STYLE_FIXTURE="${sampleValue}"
    printf '%s\n' "${FSUSBLOG_STYLE_FIXTURE}"
}

PrintEmbeddedLanguage()
{
    node --input-type=module <<'NODE'
const identity = (value) => {
  return value
}
process.stdout.write(identity('fixture'))
NODE
    node --input-type=module -e '
  const value = "fixture";
  process.stdout.write(value);
'
}

PrintValue "${1:-fixture}"
PrintEmbeddedLanguage
