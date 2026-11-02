import { fetchBreadcrumbs } from '@/lib/api';
import type { ActionItem } from '@/hooks/use-item-actions';

/** Resolve overlap before deleting anything, including ancestors absent from search results. */
export async function resolveDeletionTargets(
  items: ActionItem[],
  folders: { id: string; parentId: string | null }[],
  files: { id: string; folderId: string | null }[],
) {
  const selectedFolders = new Map(items.filter(item => item.type === 'folder').map(item => [item.id, item]));
  const targets = new Map<string, ActionItem>();
  if (!selectedFolders.size || items.length < 2) return targets;
  const paths = new Map<string, Awaited<ReturnType<typeof fetchBreadcrumbs>>>();
  for (const item of items) {
    const parentId = item.type === 'folder'
      ? folders.find(folder => folder.id === item.id)?.parentId
      : files.find(file => file.id === item.id)?.folderId;
    if (!parentId) continue;
    if (!paths.has(parentId)) paths.set(parentId, await fetchBreadcrumbs(parentId));
    const ancestor = paths.get(parentId)?.find(folder => selectedFolders.has(folder.id));
    if (ancestor) targets.set(item.id, selectedFolders.get(ancestor.id)!);
  }
  return targets;
}
