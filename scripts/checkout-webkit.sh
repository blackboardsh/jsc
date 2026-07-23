#!/usr/bin/env bash

set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
ref=$(node -p "require('$root/build-metadata/webkit.json').webkitRef")
sha=$(node -p "require('$root/build-metadata/webkit.json').webkitSha")
checkout=${WEBKIT_CHECKOUT:-"$root/WebKit"}

if [[ "${JSC_LOCAL_BUILD:-0}" == 1 && -d "$checkout/.git" ]]; then
    actual_sha=$(git -C "$checkout" rev-parse HEAD)
    if [[ "$actual_sha" != "$sha" && "${JSC_ALLOW_WEBKIT_FORK:-0}" != 1 ]]; then
        echo "Local WebKit checkout is based at $actual_sha, expected $sha." >&2
        echo "Remove $checkout to adopt the new fork point, or set JSC_ALLOW_WEBKIT_FORK=1 for an intentional local WebKit branch." >&2
        exit 1
    fi
    echo "Reusing local WebKit checkout at $actual_sha (fork point: $sha)"
else
    rm -rf "$checkout"
    git clone \
        --depth 1 \
        --filter=blob:none \
        --no-checkout \
        --branch "$ref" \
        https://github.com/WebKit/WebKit.git \
        "$checkout"

    git -C "$checkout" sparse-checkout init --no-cone
    printf '%s\n' \
        '/*' \
        '!/JSTests/' \
        '!/LayoutTests/' \
        '!/ManualTests/' \
        '!/WebDriverTests/' \
        > "$checkout/.git/info/sparse-checkout"
    git -C "$checkout" checkout --detach "$sha"
fi

cmake_compatibility_patch="$root/patches/cmake-empty-linked-into.patch"
if git -C "$checkout" apply --reverse --check "$cmake_compatibility_patch" 2>/dev/null; then
    echo "WebKit CMake empty-property compatibility patch is already present"
else
    git -C "$checkout" apply "$cmake_compatibility_patch"
fi
