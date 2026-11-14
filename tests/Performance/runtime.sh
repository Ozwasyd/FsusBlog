#!/usr/bin/env bash
# Runtime evidence for the process and private work directory owned by run.sh.
# shellcheck disable=SC2154

runtime_mark() {
  local mark=$1
  own_child "$server_pid"
  printf '%s\n' "$mark" > "$run/runtime.mark.new"
  mv "$run/runtime.mark.new" "$run/runtime.mark"
  local i
  for ((i=0; i<100; i++)); do
    own_child "$server_pid"
    [[ -f "$run/$mark.ack" ]] && return 0
    sleep 0.05
  done
  printf 'No runtime evidence acknowledgment for %s\n' "$mark" >&2
  return 1
}

runtime_positive_control() {
  local path=/api/binary/comment/1 status
  runtime_mark positive-before
  status=$(curl --silent --show-error --max-time 2 --noproxy '*' "${curl_flags[@]}" \
    --output "$evidence/runtime-positive.aeds" --write-out '%{http_code}' "$target$path")
  printf 'GET %s -> %s\n' "$path" "$status" > "$evidence/runtime-positive.txt"
  [[ "$status" == 200 && -s "$evidence/runtime-positive.aeds" ]]
  runtime_mark positive-after
}

runtime_report() {
  local stage_name=$1
  runtime_mark measure-after
  # GC events can arrive from the native dispatcher after the boundary sample.
  sleep 0.25
  runtime_mark drain
  python3 "$run/source/tests/Performance/runtime.py" "$evidence/runtime.ndjson" "$evidence/$stage_name.json" \
    "$evidence/server-process.csv" "$server_pid" "$evidence/runtime-result.json" > "$evidence/runtime-report.log" 2>&1
}
