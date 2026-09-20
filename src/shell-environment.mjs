import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROVIDERS } from "./model-registry.mjs";

const DEFAULT_SHELL_FILES = Object.freeze([
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".bashrc",
  ".bash_profile",
]);

/**
 * Parse simple shell variable assignments from configuration file content.
 * Does not execute any code. Safely strips single and double quotes.
 *
 * Supported formats:
 *   export VAR="value"
 *   export VAR='value'
 *   export VAR=value
 *   VAR="value"
 *   VAR=value
 */
export function parseShellAssignments(content) {
  const result = new Map();
  if (typeof content !== "string") return result;

  const lines = content.split(/\r\n|\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let rawVal = match[2].trim();

    // Strip inline comment if not quoted
    if (rawVal.startsWith('"')) {
      const closingIndex = rawVal.indexOf('"', 1);
      if (closingIndex !== -1) {
        rawVal = rawVal.slice(1, closingIndex);
      } else {
        rawVal = rawVal.slice(1);
      }
    } else if (rawVal.startsWith("'")) {
      const closingIndex = rawVal.indexOf("'", 1);
      if (closingIndex !== -1) {
        rawVal = rawVal.slice(1, closingIndex);
      } else {
        rawVal = rawVal.slice(1);
      }
    } else {
      // Unquoted: drop trailing comment if separated by whitespace
      const commentIndex = rawVal.search(/\s+#/);
      if (commentIndex !== -1) {
        rawVal = rawVal.slice(0, commentIndex).trim();
      }
    }

    if (rawVal) {
      result.set(key, rawVal);
    }
  }

  return result;
}

/**
 * Read assignments from standard user shell configuration files.
 * Earlier files take precedence (e.g. .zshrc before .bashrc).
 */
export function readShellEnvironment(options = {}) {
  const home = options.home || os.homedir();
  const fileNames = options.files || DEFAULT_SHELL_FILES;
  const envMap = new Map();

  for (const fileName of fileNames) {
    const filePath = path.join(home, fileName);
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, "utf8");
      const parsed = parseShellAssignments(content);
      for (const [key, value] of parsed) {
        if (!envMap.has(key)) {
          envMap.set(key, { value, file: fileName, filePath });
        }
      }
    } catch {
      // Unreadable files are safely skipped
    }
  }

  return envMap;
}

/**
 * Resolve an ambient credential for a provider from process.env or shell files.
 */
export function resolveAmbientProviderCredential(providerOrId, options = {}) {
  const provider =
    typeof providerOrId === "string" ? PROVIDERS.get(providerOrId) : providerOrId;
  if (!provider || provider.kind !== "openai-compatible" || !provider.credential) {
    return undefined;
  }

  const envNames = provider.credential.environment || [];
  if (!envNames.length) return undefined;

  // 1. Check process.env first
  for (const name of envNames) {
    const value = process.env[name]?.trim();
    if (value) {
      return {
        value,
        envVar: name,
        source: `environment (${name})`,
      };
    }
  }

  // 2. Check shell files (.zshrc, etc.)
  const shellEnv = readShellEnvironment(options);
  for (const name of envNames) {
    const entry = shellEnv.get(name);
    if (entry?.value) {
      return {
        value: entry.value,
        envVar: name,
        source: `shell configuration (~/${entry.file}, ${name})`,
        file: entry.file,
      };
    }
  }

  return undefined;
}
