#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_legacy.sh"

CURRENT_TIER="cross-browser-smoke"
Log "tier=cross-browser-smoke | requires release preview=$RELEASE_PREVIEW_URL"
RequireReleasePreview

previous_playwright_browsers="${FSUSBLOG_PLAYWRIGHT_BROWSERS-}"
previous_playwright_base_url="${PLAYWRIGHT_BASE_URL-}"
previous_public_base_url="${FSUSBLOG_PUBLIC_BASE_URL-}"
previous_output_dir="${PLAYWRIGHT_OUTPUT_DIR-}"
previous_browsers_path="${PLAYWRIGHT_BROWSERS_PATH-}"
previous_ld_library_path="${LD_LIBRARY_PATH-}"
previous_disable_notification_stream="${FSUSBLOG_DISABLE_NOTIFICATION_STREAM-}"

export PLAYWRIGHT_OUTPUT_DIR="${PLAYWRIGHT_OUTPUT_DIR:-test-results/playwright/cross-browser}"
export FSUSBLOG_PLAYWRIGHT_BROWSERS="${FSUSBLOG_PLAYWRIGHT_BROWSERS:-chromium,firefox,webkit}"
# Use Playwright's standard persistent cache unless the caller explicitly
# selects another path. Fresh production cleanup owns repository .tmp output
# and must never erase installed browser toolchain dependencies.
if [[ -n "$previous_browsers_path" ]]; then
    export PLAYWRIGHT_BROWSERS_PATH="$previous_browsers_path"
else
    unset PLAYWRIGHT_BROWSERS_PATH
fi
export PLAYWRIGHT_BASE_URL="$RELEASE_PREVIEW_URL"
export FSUSBLOG_PUBLIC_BASE_URL="$RELEASE_PREVIEW_URL"
export FSUSBLOG_DISABLE_NOTIFICATION_STREAM=1

if [[ -d "$ROOT_DIR/.tmp/playwright-system-deps/root/usr/lib/x86_64-linux-gnu" ]]; then
    export LD_LIBRARY_PATH="$ROOT_DIR/.tmp/playwright-system-deps/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

ResetSecurityRuntimeState "pre cross-browser smoke"
RunInClient npm run check:cross-browser:smoke

if [[ -n "$previous_playwright_browsers" ]]; then
    export FSUSBLOG_PLAYWRIGHT_BROWSERS="$previous_playwright_browsers"
else
    unset FSUSBLOG_PLAYWRIGHT_BROWSERS
fi

if [[ -n "$previous_playwright_base_url" ]]; then
    export PLAYWRIGHT_BASE_URL="$previous_playwright_base_url"
else
    unset PLAYWRIGHT_BASE_URL
fi

if [[ -n "$previous_public_base_url" ]]; then
    export FSUSBLOG_PUBLIC_BASE_URL="$previous_public_base_url"
else
    unset FSUSBLOG_PUBLIC_BASE_URL
fi

if [[ -n "$previous_output_dir" ]]; then
    export PLAYWRIGHT_OUTPUT_DIR="$previous_output_dir"
else
    unset PLAYWRIGHT_OUTPUT_DIR
fi

if [[ -n "$previous_browsers_path" ]]; then
    export PLAYWRIGHT_BROWSERS_PATH="$previous_browsers_path"
else
    unset PLAYWRIGHT_BROWSERS_PATH
fi

if [[ -n "$previous_ld_library_path" ]]; then
    export LD_LIBRARY_PATH="$previous_ld_library_path"
else
    unset LD_LIBRARY_PATH
fi

if [[ -n "$previous_disable_notification_stream" ]]; then
    export FSUSBLOG_DISABLE_NOTIFICATION_STREAM="$previous_disable_notification_stream"
else
    unset FSUSBLOG_DISABLE_NOTIFICATION_STREAM
fi
