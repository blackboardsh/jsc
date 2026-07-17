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
    : "${CXX:?CXX must be set}"
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

# The fallback implementation is linked into Cottontail so macOS hardened
# runtime never needs to load downloaded executable code. ICU's archive data
# packaging leaves the 28 MB locale database in a standalone, shareable file;
# libicudata.a is only the tiny stub required by udata_setCommonData().
fallback_prefix="$install_prefix/fallback"
fallback_build="$source_root/build-cottontail-runtime"
fallback_lib="$install_prefix/lib/cottontail-icu"
configure_platform=Linux
fallback_cc=${CC}
fallback_cxx=${CXX}
if [[ "$platform" == macos ]]; then
    configure_platform=MacOSX
else
    # ICU 70's autoconf namespace probe predates Clang 18 and reports a false
    # negative on current Ubuntu runners. Its C ABI is compiler-independent;
    # use the runner's GCC toolchain for the pinned fallback implementation.
    fallback_cc=gcc
    fallback_cxx=g++
fi
mkdir -p "$fallback_build" "$fallback_lib"

jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)
(
    cd "$fallback_build"
    CC="$fallback_cc" CXX="$fallback_cxx" "$source_root/source/runConfigureICU" "$configure_platform" \
        --prefix="$fallback_prefix" \
        --enable-static \
        --disable-shared \
        --with-data-packaging=archive \
        --disable-tests \
        --disable-samples \
        --disable-extras \
        --disable-icuio
    make -j"$jobs"
    make install
)

for library in libicudata.a libicuuc.a libicui18n.a; do
    cp "$fallback_prefix/lib/$library" "$fallback_lib/$library"
    test -s "$fallback_lib/$library"
done
cp "$fallback_prefix/share/icu/$icu_version/icudt70l.dat" "$fallback_lib/icudt70l.dat"
test -s "$fallback_lib/icudt70l.dat"
data_sha=$(shasum -a 256 "$fallback_lib/icudt70l.dat" | awk '{ print $1 }')
cp "$source_root/LICENSE" "$fallback_lib/LICENSE"
cat > "$fallback_lib/ICU_FALLBACK.json" <<EOF
{
  "version": "$icu_version",
  "abi": $ICU_ABI_FLOOR,
  "dataFile": "icudt70l.dat",
  "dataSha256": "$data_sha",
  "source": "$url",
  "sourceSha256": "$ICU_SOURCE_SHA256"
}
EOF

printf '%s\n' \
    'Cottontail JavaScriptCore uses the operating system ICU data.' \
    'The standalone Linux jsc shell uses a build-only system ICU bridge.' \
    'Cottontail owns the unversioned ICU adapter and runtime selection policy.' \
    'SDKs also contain static ICU 70.1 fallback code and an external icudt70l.dat database.' \
    'The fallback code can be linked into a signed executable without bundling the data database.' \
    > "$install_prefix/SYSTEM_ICU_USAGE"
