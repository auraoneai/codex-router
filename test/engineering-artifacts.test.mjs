import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  artifactReference,
  createArtifactManifest,
  retrieveArtifact,
  storeArtifact,
  verifyArtifactManifest,
} from "../src/engineering/artifacts.mjs";

function fixture() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "codex-router-engineering-artifacts-"));
  return { parent, root: path.join(parent, "artifacts") };
}

test("artifact storage produces sorted SHA-256 references and verified retrieval", () => {
  const { parent, root } = fixture();
  try {
    const second = storeArtifact(root, "logs/z.log", "last\n");
    const first = storeArtifact(root, "reports/a.txt", "evidence\n");
    assert.match(first.sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(retrieveArtifact(root, first), Buffer.from("evidence\n"));
    const manifest = createArtifactManifest(root, [second.path, first.path, first.path]);
    assert.deepEqual(manifest.artifacts.map((entry) => entry.path), ["logs/z.log", "reports/a.txt"]);
    assert.deepEqual(verifyArtifactManifest(root, manifest), manifest.artifacts);
    assert.match(manifest.manifestSha256, /^[0-9a-f]{64}$/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("artifact storage is immutable but identical retries are idempotent", () => {
  const { parent, root } = fixture();
  try {
    const first = storeArtifact(root, "run/result.json", "same");
    assert.deepEqual(storeArtifact(root, "run/result.json", "same"), first);
    assert.throws(() => storeArtifact(root, "run/result.json", "different"), /immutable artifact/u);
    assert.deepEqual(retrieveArtifact(root, first), Buffer.from("same"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("artifact manifests detect metadata tampering before retrieval", () => {
  const { parent, root } = fixture();
  try {
    storeArtifact(root, "run/result.json", "same");
    const manifest = createArtifactManifest(root, ["run/result.json"]);
    const tampered = structuredClone(manifest);
    tampered.artifacts[0].path = "run/other.json";
    assert.throws(() => verifyArtifactManifest(root, tampered), /manifest digest mismatch/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("artifact paths reject traversal, absolute paths, and Windows separators", () => {
  const { parent, root } = fixture();
  try {
    assert.throws(() => storeArtifact(root, "../outside.txt", "no"), /traversal/u);
    assert.throws(() => storeArtifact(root, "nested\\..\\outside.txt", "no"), /traversal/u);
    assert.throws(() => storeArtifact(root, path.resolve(parent, "outside.txt"), "no"), /relative/u);
    assert.throws(() => storeArtifact(root, "C:\\outside.txt", "no"), /relative/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("artifact operations reject symlinked parents and files", () => {
  const { parent, root } = fixture();
  const outside = path.join(parent, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "outside\n");
  try {
    symlinkSync(outside, path.join(root, "linked-dir"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => artifactReference(root, "linked-dir/secret.txt"), /real directory/u);
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "linked-file.txt"), "file");
    assert.throws(() => artifactReference(root, "linked-file.txt"), /regular file/u);
    assert.throws(() => storeArtifact(root, "linked-file.txt", "replace"), /non-regular/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("artifact retrieval detects mutation and enforces byte bounds", () => {
  const { parent, root } = fixture();
  try {
    const reference = storeArtifact(root, "run/output.log", "original");
    writeFileSync(path.join(root, reference.path), "tampered");
    assert.throws(() => retrieveArtifact(root, reference), /digest mismatch/u);
    const current = artifactReference(root, reference.path);
    assert.throws(() => retrieveArtifact(root, current, { maxBytes: current.size - 1 }), /retrieval limit/u);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
