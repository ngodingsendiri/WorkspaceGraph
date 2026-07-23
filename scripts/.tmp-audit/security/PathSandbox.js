// src/main/security/PathSandbox.ts
import fs from "fs";
import path from "path";
function assertLexicallyInVault(resolved, root) {
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Path outside vault rejected");
  }
}
function realPathForTarget(resolved) {
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved);
  let current = path.dirname(resolved);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    current = parent;
  }
  return path.join(fs.realpathSync.native(current), path.relative(current, resolved));
}
function assertPathInVault(filePath, vaultRoot) {
  if (!vaultRoot) throw new Error("No workspace open");
  if (!filePath || typeof filePath !== "string") throw new Error("Invalid path");
  const root = path.resolve(vaultRoot);
  const resolved = path.resolve(filePath);
  assertLexicallyInVault(resolved, root);
  const realRoot = fs.existsSync(root) ? fs.realpathSync.native(root) : root;
  const realTarget = realPathForTarget(resolved);
  assertLexicallyInVault(realTarget, realRoot);
  return resolved;
}
function isPathInVault(filePath, vaultRoot) {
  try {
    assertPathInVault(filePath, vaultRoot);
    return true;
  } catch {
    return false;
  }
}
function resolveVaultRelative(relativePath, vaultRoot) {
  const clean = relativePath.replace(/^[/\\]+/, "");
  return assertPathInVault(path.join(vaultRoot, clean), vaultRoot);
}
export {
  assertPathInVault,
  isPathInVault,
  resolveVaultRelative
};
