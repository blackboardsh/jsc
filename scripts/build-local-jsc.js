#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cottontailRoot = resolve(
	process.env.COTTONTAIL_ROOT || join(root, "..", "cottontail"),
);
const cottontailManifestPath = join(
	cottontailRoot,
	"scripts",
	"jsc-manifest.json",
);

function fail(message) {
	throw new Error(`[local-jsc] ${message}`);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd || root,
		env: options.env || process.env,
		encoding: options.capture ? "utf8" : undefined,
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) {
		fail(`could not start ${command}: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const detail = options.capture
			? `\n${String(result.stderr || result.stdout || "").trim()}`
			: "";
		fail(`${command} exited with status ${result.status ?? 1}${detail}`);
	}
	return options.capture ? String(result.stdout).trim() : "";
}

function commandExists(command) {
	const probe =
		process.platform === "win32"
			? spawnSync("where.exe", [command], { stdio: "ignore" })
			: spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command], {
					stdio: "ignore",
				});
	return probe.status === 0;
}

function hostConfig() {
	const key = `${process.platform}-${process.arch}`;
	const configs = {
		"darwin-arm64": {
			platformKey: "macos-arm64",
			targetOs: "macos",
			artifactName: "cottontail-jsc-macos-arm64",
			cc: "clang",
			cxx: "clang++",
		},
		"linux-x64": {
			platformKey: "linux-x64",
			targetOs: "linux",
			artifactName: "cottontail-jsc-linux-amd64",
			cc: commandExists("clang-18") ? "clang-18" : "clang",
			cxx: commandExists("clang++-18") ? "clang++-18" : "clang++",
		},
		"linux-arm64": {
			platformKey: "linux-arm64",
			targetOs: "linux",
			artifactName: "cottontail-jsc-linux-arm64",
			cc: commandExists("clang-18") ? "clang-18" : "clang",
			cxx: commandExists("clang++-18") ? "clang++-18" : "clang++",
		},
		"win32-x64": {
			platformKey: "windows-x64",
			targetOs: "windows",
			artifactName: "cottontail-jsc-windows-amd64",
		},
	};
	return configs[key] || null;
}

function addFileTree(hash, path) {
	if (!existsSync(path)) {
		hash.update(`missing:${path}\0`);
		return;
	}
	const stats = statSync(path);
	if (stats.isDirectory()) {
		for (const entry of readdirSync(path).sort()) {
			addFileTree(hash, join(path, entry));
		}
		return;
	}
	hash.update(`file:${path}\0`);
	hash.update(readFileSync(path));
}

function addGitSnapshot(hash, repository) {
	if (!existsSync(join(repository, ".git"))) {
		hash.update(`missing-git:${repository}\0`);
		return;
	}

	// A temporary index produces one canonical tree for committed, staged,
	// unstaged, and untracked content without mutating the developer's index.
	// Committing an already-built working tree therefore does not invalidate JSC.
	const indexPath = run(
		"git",
		["rev-parse", "--path-format=absolute", "--git-path", "index"],
		{ cwd: repository, capture: true },
	);
	const tempRoot = mkdtempSync(join(tmpdir(), "cottontail-jsc-index-"));
	const tempIndex = join(tempRoot, "index");
	const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
	try {
		if (existsSync(indexPath)) {
			copyFileSync(indexPath, tempIndex);
		} else {
			run("git", ["read-tree", "HEAD"], { cwd: repository, env });
		}
		run("git", ["add", "--all"], { cwd: repository, env });
		hash.update(run("git", ["write-tree"], {
			cwd: repository,
			env,
			capture: true,
		}));
		hash.update("\0");
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

function addRepositoryPaths(hash, repository, pathspecs) {
	const tracked = run("git", ["ls-files", "-z", "--", ...pathspecs], {
		cwd: repository,
		capture: true,
	});
	const untracked = run(
		"git",
		["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs],
		{ cwd: repository, capture: true },
	);
	const paths = new Set(
		`${tracked}\0${untracked}`.split("\0").filter(Boolean),
	);
	for (const relativePath of [...paths].sort()) {
		hash.update(`path:${relativePath}\0`);
		addFileTree(hash, join(repository, relativePath));
	}
}

function sourceFingerprint(manifest, config) {
	const hash = createHash("sha256");
	hash.update("cottontail-local-jsc-v1\0");
	hash.update(`${config.platformKey}\0${manifest.upstreamTag}\0${manifest.upstreamCommit}\0`);
	hash.update(`${process.env.CC || config.cc || ""}\0${process.env.CXX || config.cxx || ""}\0`);
	addRepositoryPaths(hash, root, [
		"bridge",
		"patches",
		"scripts/build-local-jsc.js",
		"scripts/build-unix-jsc.sh",
		"scripts/build-windows-jsc.ps1",
		"scripts/checkout-webkit.sh",
		"scripts/prepare-system-icu.sh",
		"scripts/verify-windows-icu-contract.js",
	]);
	addGitSnapshot(hash, join(root, "WebKit"));
	return hash.digest("hex");
}

function icuFingerprint(config) {
	const hash = createHash("sha256");
	hash.update(`cottontail-local-icu-v1\0${config.targetOs}\0`);
	addFileTree(hash, join(root, "bridge"));
	addFileTree(hash, join(root, "scripts", "prepare-system-icu.sh"));
	return hash.digest("hex");
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function localStateIsCurrent(statePath, fingerprint, archivePath, dataPath) {
	if (!existsSync(statePath) || !existsSync(archivePath) || !existsSync(dataPath)) {
		return false;
	}
	try {
		const state = readJson(statePath);
		return state.schema === 1 && state.fingerprint === fingerprint;
	} catch {
		return false;
	}
}

function writeBuildMetadata(manifest) {
	const jscRevision = run("git", ["rev-parse", "HEAD"], {
		cwd: root,
		capture: true,
	});
	const metadata = {
		schema: 1,
		webkitRef: manifest.upstreamTag,
		webkitSha: manifest.upstreamCommit,
		buildRevision: jscRevision,
		local: true,
	};
	mkdirSync(join(root, "build-metadata"), { recursive: true });
	writeFileSync(
		join(root, "build-metadata", "webkit.json"),
		`${JSON.stringify(metadata, null, 2)}\n`,
	);
}

function build(config, manifest) {
	writeBuildMetadata(manifest);
	const env = {
		...process.env,
		COTTONTAIL_ROOT: cottontailRoot,
		JSC_LOCAL_BUILD: "1",
		JSC_LOCAL_ICU_KEY: icuFingerprint(config),
	};

	if (config.targetOs === "windows") {
		Object.assign(env, {
			WINDOWS_JSCONLY_PATCH_COMMIT:
				"2d96c99b553946b611978b26dd1f83a8b68be10a",
			WINDOWS_JSCONLY_PATCH_SHA256:
				"c5a909008db01b72d7af7a2204dc6223fa24f9588aa7841370a21f4381cec767",
			WINDOWS_MSVC_ATTRIBUTE_PATCH_COMMIT:
				"87d57a3fc39c408dd484cd3341a9448f3be2208d",
			WINDOWS_MSVC_ATTRIBUTE_PATCH_SHA256:
				"baf88f17960706e82d1919bbbe109a58f74f1dcb6a263971774a8e693aca1ee1",
		});
		const powershell = commandExists("pwsh") ? "pwsh" : "powershell.exe";
		run(
			powershell,
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				join(root, "scripts", "build-windows-jsc.ps1"),
			],
			{ env },
		);
		return;
	}

	run("bash", [join(root, "scripts", "build-unix-jsc.sh")], {
		env: {
			...env,
			TARGET_OS: config.targetOs,
			PLATFORM_KEY: config.platformKey,
			ARTIFACT_NAME: config.artifactName,
			CC: process.env.CC || config.cc,
			CXX: process.env.CXX || config.cxx,
		},
	});
}

function main() {
	const config = hostConfig();
	if (!config) {
		fail(`unsupported host ${process.platform}-${process.arch}`);
	}
	if (!existsSync(cottontailManifestPath)) {
		fail(`Cottontail JSC manifest not found: ${cottontailManifestPath}`);
	}
	const manifest = readJson(cottontailManifestPath);
	if (!manifest.upstreamTag || !manifest.upstreamCommit) {
		fail(`Cottontail JSC manifest has no upstream fork point`);
	}

	const archivePath = join(root, "release", `${config.artifactName}.tar.gz`);
	const dataPath = join(root, "release", `icudt70l-${config.platformKey}.dat`);
	const statePath = join(root, "release", `local-${config.platformKey}.json`);
	const fingerprint = sourceFingerprint(manifest, config);
	const force =
		process.argv.includes("--force") ||
		["1", "true", "yes"].includes(
			String(process.env.DASH_LOCAL_REBUILD_JSC || "").toLowerCase(),
		);

	if (!force && localStateIsCurrent(statePath, fingerprint, archivePath, dataPath)) {
		console.log(`[local-jsc] Using cached ${config.platformKey} SDK`);
		console.log(JSON.stringify({ archivePath, dataPath, platform: config.platformKey }));
		return;
	}

	console.log(
		`[local-jsc] Building ${manifest.upstreamTag} for ${config.platformKey}`,
	);
	build(config, manifest);

	const completedFingerprint = sourceFingerprint(manifest, config);
	const state = {
		schema: 1,
		platform: config.platformKey,
		fingerprint: completedFingerprint,
		archivePath,
		dataPath,
		builtAt: new Date().toISOString(),
	};
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
	console.log(JSON.stringify({ archivePath, dataPath, platform: config.platformKey }));
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
