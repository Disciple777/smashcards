/**
 * Pure helpers over the flat folder list the API returns.
 *
 * The API sends every folder for a user in one GET /v1/folders call — folders
 * rarely number more than a few dozen for one person — and the client builds
 * the tree, breadcrumbs, and recursive counts locally rather than paying a
 * round trip per folder navigated into. This file is that assembly logic,
 * kept separate from any component so it can be unit-tested without a DOM.
 */

/** Direct children of `parentId` (null for root), alphabetical. */
export function childFolders(folders, parentId) {
  return (folders ?? [])
    .filter((f) => f.parent_id === parentId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Decks whose folder_id matches `folderId` (null for root), by title. */
export function decksInFolder(decks, folderId) {
  return (decks ?? [])
    .filter((d) => (d.folder_id ?? null) === folderId)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** The chain of folders from the root down to `folderId`, inclusive. Empty at root. */
export function breadcrumbPath(folders, folderId) {
  const byId = new Map((folders ?? []).map((f) => [f.id, f]));
  const path = [];
  let current = folderId != null ? byId.get(folderId) : null;

  // A folder deleted out from under a stale reference simply ends the walk
  // early rather than throwing — the caller lands on the deepest folder that
  // still exists.
  while (current) {
    path.unshift(current);
    current = current.parent_id != null ? byId.get(current.parent_id) : null;
  }

  return path;
}

/**
 * True if `candidateId` is `ancestorId` itself, or lives anywhere in its
 * subtree. Mirrors the server's FolderTree::wouldCreateCycle — used to grey
 * out invalid destinations in the move picker before the request round-trips.
 * The server is still the authority; this is UX, not the real guard.
 */
export function isSelfOrDescendant(folders, candidateId, ancestorId) {
  if (candidateId === ancestorId) return true;

  const byId = new Map((folders ?? []).map((f) => [f.id, f]));
  let current = byId.get(candidateId);
  const seen = new Set();

  while (current) {
    if (current.id === ancestorId) return true;
    if (seen.has(current.id)) return false; // defensive: don't loop on bad data
    seen.add(current.id);
    current = current.parent_id != null ? byId.get(current.parent_id) : null;
  }

  return false;
}

/**
 * Every deck inside `folderId` or any of its nested subfolders — what a
 * "12 decks" badge on a folder row means, as opposed to only its direct decks.
 */
export function decksInFolderRecursive(folders, decks, folderId) {
  const ids = new Set([folderId]);
  let grew = true;

  // Breadth-first expansion until a pass adds nothing new — bounded by the
  // folder count, so a pathological tree still terminates.
  while (grew) {
    grew = false;
    for (const folder of folders ?? []) {
      if (folder.parent_id != null && ids.has(folder.parent_id) && !ids.has(folder.id)) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }

  return (decks ?? []).filter((d) => ids.has(d.folder_id ?? null));
}

/**
 * A depth-first, indented flat list for a <select> — "Spanish" then its
 * children indented under it, then the next root folder. `excludeSubtreeOf`
 * drops a folder and everything under it, so moving a folder can't offer
 * itself or its own descendants as a destination.
 */
export function flattenForPicker(folders, { excludeSubtreeOf = null } = {}) {
  const excluded = new Set();
  if (excludeSubtreeOf != null) {
    excluded.add(excludeSubtreeOf);
    let grew = true;
    while (grew) {
      grew = false;
      for (const folder of folders ?? []) {
        if (folder.parent_id != null && excluded.has(folder.parent_id) && !excluded.has(folder.id)) {
          excluded.add(folder.id);
          grew = true;
        }
      }
    }
  }

  const out = [];

  function visit(parentId, depth) {
    for (const folder of childFolders(folders, parentId)) {
      if (excluded.has(folder.id)) continue;
      out.push({ id: folder.id, name: folder.name, depth });
      visit(folder.id, depth + 1);
    }
  }

  visit(null, 0);
  return out;
}
