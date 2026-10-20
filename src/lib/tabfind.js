// Ranks sessions for the sidebar's inline filter. Names match first; a session whose
// name misses can still match on its folder path, a little lower. Favorites and the
// current Space's sessions edge out sessions parked in other Spaces.
import { fuzzy } from './fuzzy.js';

const PATH_PENALTY = 25;
const HERE_BONUS = 10;

// items: [{ tid, name, path, spaceId }]; spaceId is null for Favorites.
export function findTabs(query, items, activeSpaceId) {
  const q = query.trim();
  if (!q) return [];
  const hits = [];
  for (const it of items) {
    const byName = fuzzy(q, it.name);
    const byPath = byName ? null : it.path ? fuzzy(q, it.path) : null;
    if (!byName && !byPath) continue;
    const here = it.spaceId == null || it.spaceId === activeSpaceId;
    hits.push({
      ...it,
      on: byName ? 'name' : 'path',
      indices: (byName || byPath).indices,
      score: (byName ? byName.score : byPath.score - PATH_PENALTY) + (here ? HERE_BONUS : 0),
    });
  }
  return hits.sort((a, b) => b.score - a.score);
}
