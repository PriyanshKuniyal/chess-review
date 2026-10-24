// Checks GitHub Releases for a newer version of the app (at most every 6 hours).
let cache = { at: 0, value: null };

const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
function newer(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export function repoSlug(pkg) {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
  const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url);
  return m ? m[1] : null;
}

export async function checkForUpdate(slug, current) {
  if (!slug || process.env.CHESS_REVIEW_NO_UPDATE_CHECK) return null;
  if (Date.now() - cache.at < 6 * 3600e3) return cache.value;
  cache.at = Date.now();
  try {
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { 'User-Agent': 'chess-review', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return (cache.value = null);
    const rel = await res.json();
    cache.value = newer(rel.tag_name, current) ? { version: rel.tag_name.replace(/^v/, ''), url: rel.html_url } : null;
  } catch {
    cache.value = null;
  }
  return cache.value;
}
