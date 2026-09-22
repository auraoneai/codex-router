import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  closeSync,
  constants as fsConstants,
} from "node:fs";
import path from "node:path";

export const ARTIFACT_MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_ARTIFACT_READ_LIMIT = 16 * 1024 * 1024;

function normalizedRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath === "" || relativePath.includes("\0")) {
    throw new TypeError("Artifact path must be a non-empty relative path.");
  }
  if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error("Artifact path must be relative to the artifact root.");
  }
  const portable = relativePath.replaceAll("\\", "/");
  const parts = portable.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Artifact path contains an unsafe traversal component.");
  }
  return parts.join("/");
}

function assertDirectoryNoLink(directory, label) {
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
}

function ensureRoot(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertDirectoryNoLink(root, "Artifact root");
  return realpathSync(root);
}

function assertExistingParents(rootReal, relativePath, { create = false } = {}) {
  const parts = relativePath.split("/");
  let current = rootReal;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      assertDirectoryNoLink(current, "Artifact path component");
    } catch (error) {
      if (!create || error?.code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
      assertDirectoryNoLink(current, "Artifact path component");
    }
  }
  return path.join(rootReal, ...parts);
}

function secureExistingArtifact(root, relativePath) {
  const safePath = normalizedRelativePath(relativePath);
  const rootReal = ensureRoot(root);
  const target = assertExistingParents(rootReal, safePath);
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Artifact must be a regular file: ${safePath}`);
  }
  const resolved = realpathSync(target);
  if (resolved !== target || !resolved.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`Artifact escapes its root: ${safePath}`);
  }
  return { rootReal, target, relativePath: safePath, metadata };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestDigest(artifacts) {
  return digest(Buffer.from(JSON.stringify(artifacts), "utf8"));
}

export function storeArtifact(root, relativePath, contents) {
  const safePath = normalizedRelativePath(relativePath);
  const rootReal = ensureRoot(root);
  const target = assertExistingParents(rootReal, safePath, { create: true });
  const bytes = Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(String(contents), "utf8");
  try {
    const existing = lstatSync(target);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace a non-regular artifact: ${safePath}`);
    }
    const reference = artifactReference(rootReal, safePath);
    if (reference.size === bytes.byteLength && reference.sha256 === digest(bytes)) return reference;
    throw new Error(`Refusing to overwrite immutable artifact: ${safePath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${target}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, bytes);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      // Linking a complete same-directory temporary into place is an atomic
      // no-replace publication. A concurrent writer cannot be overwritten.
      linkSync(temporary, target);
      unlinkSync(temporary);
      chmodSync(target, 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = artifactReference(rootReal, safePath);
      if (existing.size !== bytes.byteLength || existing.sha256 !== digest(bytes)) {
        throw new Error(`Refusing to overwrite immutable artifact: ${safePath}`);
      }
      rmSync(temporary, { force: true });
      return existing;
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  return artifactReference(rootReal, safePath);
}

export function artifactReference(root, relativePath) {
  const secure = secureExistingArtifact(root, relativePath);
  const descriptor = openSync(secure.target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return {
    path: secure.relativePath,
    size: bytes.byteLength,
    sha256: digest(bytes),
  };
}

export function createArtifactManifest(root, relativePaths) {
  if (!Array.isArray(relativePaths)) throw new TypeError("Artifact paths must be an array.");
  const unique = [...new Set(relativePaths.map(normalizedRelativePath))].sort();
  const artifacts = unique.map((relativePath) => artifactReference(root, relativePath));
  return {
    schemaVersion: ARTIFACT_MANIFEST_SCHEMA_VERSION,
    algorithm: "sha256",
    artifacts,
    manifestSha256: manifestDigest(artifacts),
  };
}

export function retrieveArtifact(root, reference, { maxBytes = DEFAULT_ARTIFACT_READ_LIMIT } = {}) {
  if (reference === null || typeof reference !== "object" || Array.isArray(reference)) {
    throw new TypeError("Artifact reference must be an object.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("Artifact read limit must be a non-negative safe integer.");
  if (!Number.isSafeInteger(reference.size) || reference.size < 0 || !/^[0-9a-f]{64}$/u.test(reference.sha256 ?? "")) {
    throw new Error("Artifact reference has invalid size or SHA-256 metadata.");
  }
  const secure = secureExistingArtifact(root, reference.path);
  if (secure.metadata.size !== reference.size) throw new Error(`Artifact size mismatch: ${secure.relativePath}`);
  if (reference.size > maxBytes) throw new Error(`Artifact exceeds the retrieval limit: ${secure.relativePath}`);
  const descriptor = openSync(secure.target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (digest(bytes) !== reference.sha256) throw new Error(`Artifact digest mismatch: ${secure.relativePath}`);
  return bytes;
}

export function verifyArtifactManifest(root, manifest, options) {
  if (
    manifest?.schemaVersion !== ARTIFACT_MANIFEST_SCHEMA_VERSION
    || manifest?.algorithm !== "sha256"
    || !Array.isArray(manifest.artifacts)
    || !/^[0-9a-f]{64}$/u.test(manifest.manifestSha256 ?? "")
  ) {
    throw new Error("Artifact manifest is malformed or unsupported.");
  }
  if (manifestDigest(manifest.artifacts) !== manifest.manifestSha256) {
    throw new Error("Artifact manifest digest mismatch.");
  }
  return manifest.artifacts.map((reference) => {
    retrieveArtifact(root, reference, options);
    return { ...reference };
  });
}
