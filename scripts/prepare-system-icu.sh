#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "usage: $0 INSTALL_PREFIX PLATFORM" >&2
    exit 2
fi

: "${ICU_SOURCE_SHA256:?ICU_SOURCE_SHA256 must be set}"
: "${ICU_ABI_FLOOR:?ICU_ABI_FLOOR must be set}"

if [[ "$ICU_ABI_FLOOR" != 70 ]]; then
    echo "this header bundle is for ICU ABI floor 70, not $ICU_ABI_FLOOR" >&2
    exit 2
fi

install_prefix=$1
platform=$2
icu_version=70.1
archive="$RUNNER_TEMP/icu4c-${icu_version}-src.tgz"
source_root="$RUNNER_TEMP/icu4c-${icu_version}-src"
url="https://github.com/unicode-org/icu/releases/download/release-70-1/icu4c-70_1-src.tgz"

rm -rf "$install_prefix" "$source_root"
mkdir -p "$install_prefix/include" "$install_prefix/lib" "$source_root"

curl --fail --location --retry 3 --output "$archive" "$url"
actual_sha=$(shasum -a 256 "$archive" | awk '{ print $1 }')
if [[ "$actual_sha" != "$ICU_SOURCE_SHA256" ]]; then
    echo "ICU source checksum mismatch: $actual_sha" >&2
    exit 1
fi

tar -xzf "$archive" -C "$source_root" --strip-components=1
mkdir -p "$install_prefix/include/unicode"
cp -R "$source_root/source/common/unicode/." "$install_prefix/include/unicode/"
cp -R "$source_root/source/i18n/unicode/." "$install_prefix/include/unicode/"

if [[ "$platform" == linux ]]; then
    : "${CC:?CC must be set}"
    bridge_root=$(cd "$(dirname "$0")/../bridge" && pwd)
    "$CC" -O2 -fPIC -fvisibility=hidden -I"$bridge_root" \
        -DCOTTONTAIL_ICU_MIN_VERSION="$ICU_ABI_FLOOR" \
        -c "$bridge_root/linux-loader.c" -o "$install_prefix/lib/linux-loader.o"
    "$CC" -fPIC -I"$bridge_root" \
        -c "$bridge_root/linux-trampolines.S" -o "$install_prefix/lib/linux-trampolines.o"
    ar rcs "$install_prefix/lib/libcottontail_icu.a" \
        "$install_prefix/lib/linux-loader.o" \
        "$install_prefix/lib/linux-trampolines.o"
    cp "$install_prefix/lib/libcottontail_icu.a" "$install_prefix/lib/libicuuc.a"
    ar rcs "$install_prefix/lib/libicui18n.a"
    ar rcs "$install_prefix/lib/libicudata.a"
elif [[ "$platform" != macos ]]; then
    echo "unsupported platform: $platform" >&2
    exit 2
fi

printf '%s\n' \
    'Cottontail JavaScriptCore uses the operating system ICU data.' \
    'Linux applications must link libcottontail_icu.a and libdl.' \
    'The bridge accepts system ICU 70 and newer and adapts version-suffixed C symbols.' \
    'macOS applications link the system libicucore library.' \
    > "$install_prefix/SYSTEM_ICU_USAGE"
