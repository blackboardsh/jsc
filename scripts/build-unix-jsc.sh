#!/usr/bin/env bash

set -euo pipefail

: "${TARGET_OS:?TARGET_OS is required}"
: "${PLATFORM_KEY:?PLATFORM_KEY is required}"
: "${ARTIFACT_NAME:?ARTIFACT_NAME is required}"
: "${CC:?CC is required}"
: "${CXX:?CXX is required}"

root=$(cd "$(dirname "$0")/.." && pwd)
export RUNNER_TEMP=${RUNNER_TEMP:-"$root/.build-temp"}
export WEBKIT_OUTPUTDIR=${WEBKIT_OUTPUTDIR:-"$root/WebKitBuild"}
export ICU_PREFIX=${ICU_PREFIX:-"$root/icu-build"}
export ICU_ABI_FLOOR=70
export ICU_SOURCE_SHA256=8d205428c17bf13bb535300669ed28b338a157b1c01ae66d31d0d3e2d47c3fd5
mkdir -p "$RUNNER_TEMP" "$root/release"

jsc_cxxflags="-DU_DISABLE_RENAMING=1"
if [[ "$TARGET_OS" == linux ]]; then
    # Match Cottontail's Clang/GNU bridge setup. The runner's LLVM package does
    # not reliably discover the machine image's GCC headers or libraries, so
    # point Clang at the exact native GCC installation while retaining the
    # libstdc++ ABI expected by the published JSC archives.
    libgcc=$(g++ -print-file-name=libgcc.a)
    if [[ ! -f "$libgcc" ]]; then
        echo "g++ could not locate libgcc.a: $libgcc" >&2
        exit 1
    fi
    gcc_install_dir=$(dirname "$libgcc")
    jsc_cxxflags="--gcc-install-dir=$gcc_install_dir -stdlib=libstdc++ $jsc_cxxflags"
fi

bash "$root/scripts/checkout-webkit.sh"
bash "$root/scripts/prepare-system-icu.sh" "$ICU_PREFIX" "$TARGET_OS"

cd "$root/WebKit"
if [[ "$TARGET_OS" == linux ]]; then
    icu_data="$ICU_PREFIX/lib/libicudata.a"
    icu_i18n="$ICU_PREFIX/lib/libicui18n.a"
    icu_uc="$ICU_PREFIX/lib/libicuuc.a"
    platform_cmake_args=""
else
    icu_system_library="$(xcrun --show-sdk-path)/usr/lib/libicucore.tbd"
    test -s "$icu_system_library"
    icu_data="$icu_system_library"
    icu_i18n="$icu_system_library"
    icu_uc="$icu_system_library"
    platform_cmake_args="-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0"
fi

CFLAGS=-DU_DISABLE_RENAMING=1 CXXFLAGS="$jsc_cxxflags" \
Tools/Scripts/build-jsc \
    --jsc-only \
    --release \
    --cmakeargs="-DENABLE_STATIC_JSC=ON -DENABLE_API_TESTS=OFF -DENABLE_JIT=ON -DENABLE_DFG_JIT=ON -DENABLE_FTL_JIT=ON -DENABLE_WEBASSEMBLY=ON -DENABLE_WEBASSEMBLY_BBQJIT=ON -DENABLE_WEBASSEMBLY_OMGJIT=ON -DENABLE_SAMPLING_PROFILER=OFF -DENABLE_REMOTE_INSPECTOR=OFF $platform_cmake_args -DICU_INCLUDE_DIR=$ICU_PREFIX/include -DICU_DATA_LIBRARY_RELEASE=$icu_data -DICU_I18N_LIBRARY_RELEASE=$icu_i18n -DICU_UC_LIBRARY_RELEASE=$icu_uc"

jsc_binary=$(find "$WEBKIT_OUTPUTDIR" -type f -path '*/bin/jsc' -perm -111 -print -quit)
test -n "$jsc_binary"
jsc_build_dir=$(cd "$(dirname "$jsc_binary")/.." && pwd)
for feature in ENABLE_JIT ENABLE_DFG_JIT ENABLE_FTL_JIT ENABLE_WEBASSEMBLY ENABLE_WEBASSEMBLY_BBQJIT ENABLE_WEBASSEMBLY_OMGJIT; do
    grep -Eq "^#define ${feature} 1$" "$jsc_build_dir/cmakeconfig.h"
done
for feature in ENABLE_SAMPLING_PROFILER ENABLE_REMOTE_INSPECTOR; do
    grep -Eq "^#define ${feature} 0$" "$jsc_build_dir/cmakeconfig.h"
done
"$jsc_binary" -e 'const n=new Intl.NumberFormat("fr-FR",{useGrouping:false,minimumFractionDigits:1});if(n.format(1.5)!=="1,5")throw new Error("Intl failed");if("e\u0301".normalize("NFC")!=="é")throw new Error("normalization failed");const w=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,7,1,3,97,110,115,0,0,10,6,1,4,0,65,42,11]);if(new WebAssembly.Instance(new WebAssembly.Module(w)).exports.ans()!==42)throw new Error("WebAssembly failed")'
if [[ "$TARGET_OS" == linux ]]; then
    ! ldd "$jsc_binary" | grep -q 'libicu'
    ! nm -u "$jsc_build_dir/lib/libJavaScriptCore.a" | grep -E ' U u[a-zA-Z0-9_]+_[0-9]+$'
fi

package_dir="$RUNNER_TEMP/$ARTIFACT_NAME"
rm -rf "$package_dir"
mkdir -p "$package_dir/bin" "$package_dir/lib" "$package_dir/share/cottontail-jsc" \
    "$package_dir/include/JavaScriptCore" "$package_dir/include/wtf" "$package_dir/include/bmalloc"
cp "$jsc_binary" "$package_dir/bin/"
find "$jsc_build_dir/lib" -maxdepth 1 -type f \( -name '*.a' -o -name '*.dylib' -o -name '*.so*' \) -exec cp {} "$package_dir/lib/" \;
cp -R "$ICU_PREFIX/lib/cottontail-icu" "$package_dir/lib/"
# The 28 MB database is published once by the fan-in job, not duplicated in
# every SDK. Keep the metadata and static fallback code in the SDK.
rm "$package_dir/lib/cottontail-icu/icudt70l.dat"
cp "$root/bridge/icu-symbols.inc" "$package_dir/share/cottontail-jsc/"
printf 'ICU_ABI_FLOOR=%s\n' "$ICU_ABI_FLOOR" > "$package_dir/share/cottontail-jsc/ICU_ABI"
cp "$ICU_PREFIX/SYSTEM_ICU_USAGE" "$package_dir/"
cp "$jsc_build_dir/cmakeconfig.h" "$package_dir/include/"
cp -R "$jsc_build_dir/JavaScriptCore/Headers/JavaScriptCore/." "$package_dir/include/JavaScriptCore/"
cp -R "$jsc_build_dir/WTF/Headers/wtf/." "$package_dir/include/wtf/"
if [[ -d "$jsc_build_dir/bmalloc/Headers/bmalloc" ]]; then
    cp -R "$jsc_build_dir/bmalloc/Headers/bmalloc/." "$package_dir/include/bmalloc/"
fi
if [[ -d "$jsc_build_dir/JavaScriptCore/DerivedSources" ]]; then
    find "$jsc_build_dir/JavaScriptCore/DerivedSources" -type f -name '*.h' -exec cp {} "$package_dir/include/JavaScriptCore/" \;
fi
if [[ "${JSC_LOCAL_BUILD:-0}" == 1 ]]; then
    git -C "$root/WebKit" rev-parse HEAD > "$package_dir/WEBKIT_REVISION"
else
    node -p "require('$root/build-metadata/webkit.json').webkitSha" > "$package_dir/WEBKIT_REVISION"
fi

archive="$root/release/$ARTIFACT_NAME.tar.gz"
tar -C "$RUNNER_TEMP" -czf "$archive" "$ARTIFACT_NAME"
shasum -a 256 "$archive" > "$archive.sha256"
cp "$ICU_PREFIX/lib/cottontail-icu/icudt70l.dat" "$root/release/icudt70l-$PLATFORM_KEY.dat"
