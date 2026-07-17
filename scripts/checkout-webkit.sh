#!/usr/bin/env bash

set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
ref=$(node -p "require('$root/build-metadata/webkit.json').webkitRef")
sha=$(node -p "require('$root/build-metadata/webkit.json').webkitSha")
checkout=${WEBKIT_CHECKOUT:-"$root/WebKit"}

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
