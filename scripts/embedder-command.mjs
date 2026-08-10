import { basename, isAbsolute, resolve, win32 } from "node:path";

export function rewriteCompileCommand({
  command,
  directory,
  originalSource,
  source,
  object,
  platform,
}) {
  const quotedObject = quoteShellValue(object, platform);
  const outputPatterns = platform === "win32"
    ? [
        /\/Fo(?:"[^"]+"|\S+)/i,
        /-o\s+(?:"[^"]+"|'[^']+'|\S+)/,
      ]
    : [/-o\s+(?:'[^']+'|"[^"]+"|\S+)/];

  let outputReplaced = false;
  for (const pattern of outputPatterns) {
    if (!pattern.test(command)) continue;
    command = command.replace(pattern, platform === "win32" && pattern.source.startsWith("\\/Fo")
      ? `/Fo${quotedObject}`
      : `-o ${quotedObject}`);
    outputReplaced = true;
    break;
  }
  if (!outputReplaced) {
    throw new Error(`Could not replace compiler output in command: ${command}`);
  }

  let rewritten = replaceSourceToken(
    command,
    originalSource,
    source,
    directory,
    platform,
  );
  if (!containsPathToken(rewritten, source, directory, platform)) {
    throw new Error(`Rewritten command does not contain the embedder source: ${rewritten}`);
  }
  if (platform === "win32") {
    rewritten = ensureCompileDefinition(
      rewritten,
      "STATICALLY_LINKED_WITH_JavaScriptCore",
    );
  }
  return rewritten;
}

export function quoteShellValue(value, platform) {
  return platform === "win32"
    ? `"${value.replaceAll('"', '\\"')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function replaceSourceToken(command, originalSource, source, directory, platform) {
  const replacement = quoteShellValue(source, platform);
  const variants = pathVariants(originalSource, directory, platform)
    .sort((left, right) => right.length - left.length);

  for (const variant of variants) {
    for (const token of [`"${variant}"`, `'${variant}'`, variant]) {
      const pattern = new RegExp(`(^|\\s)${escapeRegExp(token)}(?=\\s|$)`);
      if (!pattern.test(command)) continue;
      return command.replace(pattern, (_, prefix) => `${prefix}${replacement}`);
    }
  }

  // CMake can normalize compile_commands paths independently from the command.
  // Match the unique source argument by basename as a final guarded fallback.
  const name = escapeRegExp(basename(originalSource.replaceAll("\\", "/")));
  const sourcePattern = new RegExp(
    `(^|\\s)(?:"[^"\\r\\n]*[/\\\\]${name}"|'[^'\\r\\n]*[/\\\\]${name}'|[^\\s"']*[/\\\\]${name}|${name})(?=\\s|$)`,
    "g",
  );
  const matches = [...command.matchAll(sourcePattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Could not uniquely replace source ${originalSource}; found ${matches.length} command tokens`,
    );
  }
  return command.replace(sourcePattern, (_, prefix) => `${prefix}${replacement}`);
}

function containsPathToken(command, value, directory, platform) {
  return pathVariants(value, directory, platform).some(variant =>
    command.includes(`"${variant}"`) ||
    command.includes(`'${variant}'`) ||
    command.includes(variant)
  );
}

function pathVariants(value, directory, platform) {
  const values = new Set();
  const add = candidate => {
    if (!candidate) return;
    values.add(candidate);
    values.add(candidate.replaceAll("\\", "/"));
    values.add(candidate.replaceAll("/", "\\"));
  };

  add(value);
  if (platform === "win32") {
    const windowsValue = value.replaceAll("/", "\\");
    const windowsDirectory = directory.replaceAll("/", "\\");
    add(win32.isAbsolute(windowsValue)
      ? win32.normalize(windowsValue)
      : win32.resolve(windowsDirectory, windowsValue));
  } else {
    add(isAbsolute(value) ? value : resolve(directory, value));
  }
  return [...values];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCompileDefinition(command, name) {
  const definition = escapeRegExp(name);
  return new RegExp(
    `(?:^|\\s)["']?(?:-D|/D)${definition}(?:=1)?["']?(?=\\s|$)`,
  ).test(command);
}

function ensureCompileDefinition(command, name) {
  return hasCompileDefinition(command, name) ? command : `${command} /D${name}`;
}
