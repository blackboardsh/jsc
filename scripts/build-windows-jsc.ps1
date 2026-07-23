$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$metadata = Get-Content (Join-Path $root 'build-metadata/webkit.json') -Raw | ConvertFrom-Json
$webkit = Join-Path $root 'WebKit'
$output = Join-Path $root 'WebKitBuild'
$temp = Join-Path $root '.build-temp'
$icuPrefix = Join-Path $root 'icu-build'
$artifactName = 'cottontail-jsc-windows-amd64'
$icuHash = '8d205428c17bf13bb535300669ed28b338a157b1c01ae66d31d0d3e2d47c3fd5'
$localBuild = $env:JSC_LOCAL_BUILD -eq '1'

if ($localBuild) {
  Remove-Item $output, $temp, $icuPrefix -Recurse -Force -ErrorAction Ignore
} else {
  Remove-Item $webkit, $output, $temp, $icuPrefix -Recurse -Force -ErrorAction Ignore
}
New-Item -ItemType Directory -Force -Path $temp, $icuPrefix, (Join-Path $root 'release') | Out-Null
if ($localBuild -and (Test-Path (Join-Path $webkit '.git'))) {
  $actualSha = (& git -C $webkit rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the local WebKit checkout' }
  if ($actualSha -ne $metadata.webkitSha -and $env:JSC_ALLOW_WEBKIT_FORK -ne '1') {
    throw "Local WebKit checkout is based at $actualSha, expected $($metadata.webkitSha). Remove $webkit to adopt the new fork point, or set JSC_ALLOW_WEBKIT_FORK=1 for an intentional local WebKit branch."
  }
  Write-Host "Reusing local WebKit checkout at $actualSha (fork point: $($metadata.webkitSha))"
} else {
  git clone --depth 1 --filter=blob:none --no-checkout --branch $metadata.webkitRef https://github.com/WebKit/WebKit.git $webkit
  if ($LASTEXITCODE -ne 0) { throw 'WebKit clone failed' }
  git -C $webkit sparse-checkout init --no-cone
  [IO.File]::WriteAllLines(
    (Join-Path $webkit '.git/info/sparse-checkout'),
    @('/*', '!/JSTests/', '!/LayoutTests/', '!/ManualTests/', '!/WebDriverTests/'),
    $utf8
  )
  git -C $webkit checkout --detach $metadata.webkitSha
  if ($LASTEXITCODE -ne 0) { throw 'WebKit checkout failed' }
}

Push-Location $webkit
try {
  $patches = @(
    @($env:WINDOWS_JSCONLY_PATCH_COMMIT, $env:WINDOWS_JSCONLY_PATCH_SHA256, $null),
    @($env:WINDOWS_MSVC_ATTRIBUTE_PATCH_COMMIT, $env:WINDOWS_MSVC_ATTRIBUTE_PATCH_SHA256, 'Source/WTF/wtf/Compiler.h')
  )
  foreach ($item in $patches) {
    $commit, $expectedHash, $include = $item
    $patchPath = Join-Path $temp "$commit.patch"
    Invoke-WebRequest -Uri "https://github.com/WebKit/WebKit/commit/$commit.patch" -OutFile $patchPath
    $actualHash = (Get-FileHash $patchPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw "WebKit patch checksum mismatch: $commit $actualHash" }
    $reverse = @('apply', '--reverse', '--check')
    if ($include) { $reverse += "--include=$include" }
    $reverse += $patchPath
    $ErrorActionPreference = 'Continue'
    & git @reverse 2>$null
    $reverseExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($reverseExitCode -ne 0) {
      $apply = @('apply')
      if ($include) { $apply += "--include=$include" }
      $apply += $patchPath
      $ErrorActionPreference = 'Continue'
      & git @apply
      $applyExitCode = $LASTEXITCODE
      $ErrorActionPreference = 'Stop'
      if ($applyExitCode -ne 0) { throw "WebKit patch failed: $commit" }
    }
  }

  $segmentedVector = Join-Path $webkit 'Source/WTF/wtf/SegmentedVector.h'
  $contents = [IO.File]::ReadAllText($segmentedVector)
  $old = '[[no_unique_address]] std::conditional_t<hasInlineStorage, InlineStorageData, EmptyInlineStorage> m_inlineStorageMember;'
  $new = 'NO_UNIQUE_ADDRESS std::conditional_t<hasInlineStorage, InlineStorageData, EmptyInlineStorage> m_inlineStorageMember;'
  if ($contents.Contains($old)) { [IO.File]::WriteAllText($segmentedVector, $contents.Replace($old, $new)) }
  elseif (-not $contents.Contains($new)) { throw 'SegmentedVector compatibility declaration not found' }

  $cmakeCompatibilityPatch = Join-Path $root 'patches/cmake-empty-linked-into.patch'
  $ErrorActionPreference = 'Continue'
  git apply --reverse --check $cmakeCompatibilityPatch 2>$null
  $cmakePatchReverseExitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($cmakePatchReverseExitCode -ne 0) {
    $ErrorActionPreference = 'Continue'
    git apply $cmakeCompatibilityPatch
    $cmakePatchApplyExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($cmakePatchApplyExitCode -ne 0) { throw 'WebKit CMake compatibility patch failed' }
  }

  $windowsSystemIcuPatch = Join-Path $root 'patches/windows-system-icu.patch'
  $ErrorActionPreference = 'Continue'
  git apply --reverse --check $windowsSystemIcuPatch 2>$null
  $windowsSystemIcuReverseExitCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($windowsSystemIcuReverseExitCode -ne 0) {
    $ErrorActionPreference = 'Continue'
    git apply $windowsSystemIcuPatch
    $windowsSystemIcuApplyExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($windowsSystemIcuApplyExitCode -ne 0) { throw 'Windows system ICU compatibility patch failed' }
  }
  Copy-Item (Join-Path $root 'bridge/windows-system-icu.h') 'Source/JavaScriptCore/runtime/CottontailWindowsSystemICU.h'
} finally {
  Pop-Location
}

$archive = Join-Path $temp 'icu4c-70_1-src.tgz'
$icuSource = Join-Path $temp 'icu4c-70_1-src'
Invoke-WebRequest -Uri 'https://github.com/unicode-org/icu/releases/download/release-70-1/icu4c-70_1-src.tgz' -OutFile $archive
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $icuHash) { throw 'ICU source checksum mismatch' }
New-Item -ItemType Directory -Force -Path $icuSource, (Join-Path $icuPrefix 'include/unicode') | Out-Null
tar -xzf $archive -C $icuSource --strip-components=1
Copy-Item "$icuSource/source/common/unicode/*" "$icuPrefix/include/unicode/" -Recurse -Force
Copy-Item "$icuSource/source/i18n/unicode/*" "$icuPrefix/include/unicode/" -Recurse -Force

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsInstall = (& $vswhere -latest -property installationPath).Trim()
$vsDevCmd = Join-Path $vsInstall 'Common7/Tools/VsDevCmd.bat'
$msysBash = 'C:\tools\msys64\usr\bin\bash.exe'
if (-not (Test-Path $msysBash)) { throw "MSYS2 bash not found at $msysBash" }
$icuBuild = Join-Path $temp 'icu-static-build'
$icuInstall = Join-Path $temp 'icu-static-install'
New-Item -ItemType Directory -Force -Path $icuBuild, $icuInstall | Out-Null
$sourceUnix = (& $msysBash -lc "cygpath -u '$icuSource'").Trim()
$buildUnix = (& $msysBash -lc "cygpath -u '$icuBuild'").Trim()
$installUnix = (& $msysBash -lc "cygpath -u '$icuInstall'").Trim()
$icuScript = Join-Path $temp 'build-icu.sh'
$icuScriptUnix = (& $msysBash -lc "cygpath -u '$icuScript'").Trim()
$icuScriptContents = @(
  '#!/usr/bin/env bash'
  'set -euo pipefail'
  'msvc_bin=$(cygpath -u "${VCToolsInstallDir}bin/Hostx64/x64")'
  'export PATH="$msvc_bin:/usr/local/bin:/usr/bin:/bin"'
  'echo "MSVC compiler: $(command -v cl)"'
  'echo "MSVC linker: $(command -v link)"'
  "cd '$buildUnix'"
  "CFLAGS=-MT CXXFLAGS=-MT '$sourceUnix/source/runConfigureICU' MSYS/MSVC --build=x86_64-pc-mingw32 --host=x86_64-pc-mingw32 --prefix='$installUnix' --enable-static --disable-shared --with-data-packaging=archive --disable-tests --disable-samples --disable-extras --disable-icuio"
  'make -j4'
  'make install'
) -join "`n"
[IO.File]::WriteAllText($icuScript, "$icuScriptContents`n", $utf8)
$icuCmd = Join-Path $temp 'build-icu.cmd'
[IO.File]::WriteAllLines($icuCmd, @(
  '@echo off'
  "call `"$vsDevCmd`" -arch=x64 -host_arch=x64"
  "`"$msysBash`" `"$icuScriptUnix`""
  'exit /b %errorlevel%'
), $utf8)
& cmd.exe /c $icuCmd
if ($LASTEXITCODE -ne 0) {
  $configLog = Join-Path $icuBuild 'config.log'
  if (Test-Path $configLog) { Get-Content $configLog -Tail 200 }
  throw 'Static ICU build failed'
}

$icuDirectives = & 'C:\LLVM\bin\llvm-readobj.exe' --coff-directives (Join-Path $icuInstall 'lib/sicuuc.lib') 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the static ICU runtime-library directives' }
if ($icuDirectives -match 'RuntimeLibrary=MD_DynamicRelease' -or $icuDirectives -notmatch 'RuntimeLibrary=MT_StaticRelease') {
  throw 'Static ICU must use the MT_StaticRelease runtime library'
}

$fallback = Join-Path $icuPrefix 'lib/cottontail-icu'
New-Item -ItemType Directory -Force -Path $fallback | Out-Null
Copy-Item (Join-Path $icuInstall 'lib/sicudt.lib') (Join-Path $fallback 'icudata.lib')
Copy-Item (Join-Path $icuInstall 'lib/sicuuc.lib') (Join-Path $fallback 'icuuc.lib')
Copy-Item (Join-Path $icuInstall 'lib/sicuin.lib') (Join-Path $fallback 'icui18n.lib')
Copy-Item (Join-Path $icuInstall 'share/icu/70.1/icudt70l.dat') $fallback
Copy-Item (Join-Path $icuSource 'LICENSE') $fallback
$dataHash = (Get-FileHash (Join-Path $fallback 'icudt70l.dat') -Algorithm SHA256).Hash.ToLowerInvariant()
$fallbackMetadata = @{
  version = '70.1'; abi = 70; dataFile = 'icudt70l.dat';
  msvcRuntime = 'MT';
  dataSha256 = $dataHash;
  source = 'https://github.com/unicode-org/icu/releases/download/release-70-1/icu4c-70_1-src.tgz';
  sourceSha256 = $icuHash
} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $fallback 'ICU_FALLBACK.json'), "$fallbackMetadata`n", $utf8)

$buildCmd = Join-Path $temp 'build-jsc.cmd'
[IO.File]::WriteAllLines($buildCmd, @(
  '@echo off'
  "call `"$vsDevCmd`" -arch=x64 -host_arch=x64"
  'set PATH=C:\ProgramData\chocolatey\bin;C:\Strawberry\perl\bin;%PATH%'
  "set SYSTEM_ICU_LIB=%WindowsSdkDir%Lib\%WindowsSDKVersion%um\x64\icu.lib"
  "cd /d `"$webkit`""
  "cmake -S . -B `"$output\Release`" -G Ninja -DPORT=JSCOnly -DCMAKE_BUILD_TYPE=Release -DDEVELOPER_MODE=ON -DENABLE_STATIC_JSC=ON -DENABLE_API_TESTS=OFF -DENABLE_JIT=ON -DENABLE_DFG_JIT=ON -DENABLE_FTL_JIT=ON -DENABLE_WEBASSEMBLY=ON -DENABLE_WEBASSEMBLY_BBQJIT=ON -DENABLE_WEBASSEMBLY_OMGJIT=ON -DENABLE_SAMPLING_PROFILER=OFF -DENABLE_REMOTE_INSPECTOR=OFF -DCMAKE_C_COMPILER=C:/LLVM/bin/clang-cl.exe -DCMAKE_CXX_COMPILER=C:/LLVM/bin/clang-cl.exe -DCMAKE_C_FLAGS=/DU_DISABLE_RENAMING=1 -DCMAKE_CXX_FLAGS=/DU_DISABLE_RENAMING=1 -DCMAKE_LINKER=C:/LLVM/bin/lld-link.exe -DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded -DICU_INCLUDE_DIR=`"$icuPrefix/include`" -DICU_DATA_LIBRARY_RELEASE=`"%SYSTEM_ICU_LIB%`" -DICU_I18N_LIBRARY_RELEASE=`"%SYSTEM_ICU_LIB%`" -DICU_UC_LIBRARY_RELEASE=`"%SYSTEM_ICU_LIB%`""
  'if errorlevel 1 exit /b %errorlevel%'
  "cmake --build `"$output\Release`" --target jsc --parallel"
  'exit /b %errorlevel%'
), $utf8)
& cmd.exe /c $buildCmd
if ($LASTEXITCODE -ne 0) { throw 'Windows JSC build failed' }

$jsc = Get-ChildItem $output -Recurse -File -Filter jsc.exe | Select-Object -First 1
if (-not $jsc) { throw 'jsc.exe not found' }
$buildDir = $jsc.Directory.Parent.FullName
$cmakeConfig = Get-Content "$buildDir/cmakeconfig.h" -Raw
foreach ($feature in @('ENABLE_JIT', 'ENABLE_DFG_JIT', 'ENABLE_FTL_JIT', 'ENABLE_WEBASSEMBLY', 'ENABLE_WEBASSEMBLY_BBQJIT', 'ENABLE_WEBASSEMBLY_OMGJIT')) {
  if ($cmakeConfig -notmatch "(?m)^#define $feature 1\r?$") { throw "Expected full-build feature is disabled: $feature" }
}
foreach ($feature in @('ENABLE_SAMPLING_PROFILER', 'ENABLE_REMOTE_INSPECTOR')) {
  if ($cmakeConfig -notmatch "(?m)^#define $feature 0\r?$") { throw "Expected production-only feature is enabled: $feature" }
}
$jscLibrary = Join-Path $buildDir 'lib/JavaScriptCore.lib'
if (-not (Test-Path $jscLibrary)) { throw 'JavaScriptCore.lib not found' }
node (Join-Path $root 'scripts/verify-windows-icu-contract.js') `
  'C:\LLVM\bin\llvm-nm.exe' `
  $jscLibrary `
  (Join-Path $icuInstall 'lib/sicuuc.lib') `
  (Join-Path $icuInstall 'lib/sicuin.lib') `
  (Join-Path $icuInstall 'lib/sicudt.lib')
if ($LASTEXITCODE -ne 0) { throw 'Windows ICU bridge contract verification failed' }
$smokeTest = Join-Path $temp 'jsc-smoke-test.js'
$smokeSource = 'if(new Intl.NumberFormat("fr-FR",{useGrouping:false,minimumFractionDigits:1}).format(1.5)!=="1,5")throw new Error("Intl failed");if("e\u0301".normalize("NFC")!=="\u00e9")throw new Error("normalization failed");const w=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,7,1,3,97,110,115,0,0,10,6,1,4,0,65,42,11]);if(new WebAssembly.Instance(new WebAssembly.Module(w)).exports.ans()!==42)throw new Error("WebAssembly failed");'
[IO.File]::WriteAllText($smokeTest, "$smokeSource`n", $utf8)
& $jsc.FullName $smokeTest
if ($LASTEXITCODE -ne 0) { throw 'Windows JSC smoke test failed' }
$packageDir = Join-Path $temp $artifactName
New-Item -ItemType Directory -Force -Path "$packageDir/bin", "$packageDir/lib", "$packageDir/share/cottontail-jsc", "$packageDir/include/JavaScriptCore", "$packageDir/include/wtf", "$packageDir/include/bmalloc" | Out-Null
Copy-Item $jsc.FullName "$packageDir/bin/"
Get-ChildItem "$buildDir/lib" -File | Where-Object Extension -In '.lib', '.dll' | Copy-Item -Destination "$packageDir/lib/"
Copy-Item $fallback "$packageDir/lib/" -Recurse
Remove-Item "$packageDir/lib/cottontail-icu/icudt70l.dat"
Copy-Item (Join-Path $root 'bridge/icu-symbols.inc') "$packageDir/share/cottontail-jsc/"
[IO.File]::WriteAllText("$packageDir/share/cottontail-jsc/ICU_ABI", "ICU_ABI_FLOOR=70`n", $utf8)
Copy-Item "$buildDir/cmakeconfig.h" "$packageDir/include/"
Copy-Item "$buildDir/JavaScriptCore/Headers/JavaScriptCore/*" "$packageDir/include/JavaScriptCore/" -Recurse
Copy-Item "$buildDir/WTF/Headers/wtf/*" "$packageDir/include/wtf/" -Recurse
if (Test-Path "$buildDir/bmalloc/Headers/bmalloc") { Copy-Item "$buildDir/bmalloc/Headers/bmalloc/*" "$packageDir/include/bmalloc/" -Recurse }
[IO.File]::WriteAllText("$packageDir/WEBKIT_REVISION", "$($metadata.webkitSha)`n", $utf8)
$release = Join-Path $root 'release'
$archiveOut = Join-Path $release "$artifactName.tar.gz"
tar -C $temp -czf $archiveOut $artifactName
$hash = (Get-FileHash $archiveOut -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$archiveOut.sha256", "$hash  $artifactName.tar.gz`n", $utf8)
Copy-Item (Join-Path $fallback 'icudt70l.dat') (Join-Path $release 'icudt70l-windows-x64.dat')
