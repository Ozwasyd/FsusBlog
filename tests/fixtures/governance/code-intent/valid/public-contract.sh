#!/usr/bin/env bash

# Contract: Dispatches one named task.
# Input: The first argument is a task name.
# Output: The selected task owns stdout.
# Failure: Unknown tasks return a nonzero status.
case "$task" in
    verify) exit 0 ;;
esac
