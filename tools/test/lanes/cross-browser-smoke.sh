#!/usr/bin/env bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lane-collect-support.sh"

CURRENT_TIER="cross-browser-smoke"
browser_profile="${FSUSBLOG_BROWSER_PROFILE:-browser-full-matrix}"
case "$browser_profile" in
    browser-primary-correctness)
        profile_browsers="chromium"
        profile_targets="acceptance/public-routes.spec.ts"
        profile_test_id="browser-test:primary-public-route-navigation"
        ;;
    browser-capability-delta)
        profile_browsers="chromium,firefox,webkit"
        profile_targets="acceptance/cross-browser-smoke.spec.ts"
        profile_test_id="browser-test:capability-engine-delta"
        ;;
    browser-full-matrix)
        profile_browsers="chromium,firefox,webkit"
        profile_targets="acceptance/public-routes.spec.ts acceptance/cross-browser-smoke.spec.ts"
        profile_test_id="browser-test:(primary-public-route-navigation|capability-engine-delta)"
        ;;
    *)
        Log "unknown browser capability profile: $browser_profile"
        exit 2
        ;;
esac

Log "tier=cross-browser-smoke | profile=$browser_profile | requires release preview=$RELEASE_PREVIEW_URL"
RequireReleasePreview

previous_playwright_browsers="${FSUSBLOG_PLAYWRIGHT_BROWSERS-}"
previous_playwright_base_url="${PLAYWRIGHT_BASE_URL-}"
previous_public_base_url="${FSUSBLOG_PUBLIC_BASE_URL-}"
previous_output_dir="${PLAYWRIGHT_OUTPUT_DIR-}"
previous_browsers_path="${PLAYWRIGHT_BROWSERS_PATH-}"
previous_ld_library_path="${LD_LIBRARY_PATH-}"
previous_disable_notification_stream="${FSUSBLOG_DISABLE_NOTIFICATION_STREAM-}"
previous_browser_test_targets="${FSUSBLOG_BROWSER_TEST_TARGETS-}"
previous_browser_test_grep_arg="${FSUSBLOG_BROWSER_TEST_GREP_ARG-}"

proof_args=(select --profile "$browser_profile" --output ".tmp/browser-capability-risk/$browser_profile.json")
if [[ -n "${FSUSBLOG_BROWSER_CHANGED_PATHS_FILE:-}" ]]; then
    proof_args+=(--paths-file "$FSUSBLOG_BROWSER_CHANGED_PATHS_FILE")
fi
node "$ROOT_DIR/tools/testing/browser-capability-risk.mjs" "${proof_args[@]}"

export PLAYWRIGHT_OUTPUT_DIR="test-results/playwright/$browser_profile"
export FSUSBLOG_PLAYWRIGHT_BROWSERS="$profile_browsers"
export FSUSBLOG_BROWSER_TEST_TARGETS="$profile_targets"
export FSUSBLOG_BROWSER_TEST_GREP_ARG="--grep=$profile_test_id"
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

if [[ -n "$previous_browser_test_targets" ]]; then
    export FSUSBLOG_BROWSER_TEST_TARGETS="$previous_browser_test_targets"
else
    unset FSUSBLOG_BROWSER_TEST_TARGETS
fi

if [[ -n "$previous_browser_test_grep_arg" ]]; then
    export FSUSBLOG_BROWSER_TEST_GREP_ARG="$previous_browser_test_grep_arg"
else
    unset FSUSBLOG_BROWSER_TEST_GREP_ARG
fi
