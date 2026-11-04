/** Ignore batch IDs that represent a failed folder or an orphaned descendant. */
export function validateFolderBatch(
  paths: string[], result: Record<string, string>, rootId?: string,
): Map<string, string> {
  const valid = new Map<string, string>();
  for (const path of [...paths].sort((a, b) => a.split('/').length - b.split('/').length)) {
    const separator = path.lastIndexOf('/');
    const parentPath = separator < 0 ? '' : path.slice(0, separator);
    const parentId = parentPath ? valid.get(parentPath) : rootId;
    const id = result[path];
    // The backend uses the parent ID (or an empty string) as its failure
    // fallback. Reject that ID and any descendants of a failed parent.
    if ((!parentPath || parentId) && id && id !== parentId) valid.set(path, id);
  }
  return valid;
}
