#!/usr/bin/env bash

bad_function() {
  local bad_local=value
  local tempFile="$(mktemp)"
  export badExport=value
  printf '%s\n' $bad_local
}
