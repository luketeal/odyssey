// Nightly health check: compares this run's data with the previous run and lists anything that
// should alert the maintainer. Pure functions (no I/O) so they can be unit-tested.
//
// An episode is "lost" only when it was playable last time and now has no working link at all,
// counting every source, including the Internet Archive (off by default but still loadable).
// Expiring OnePlace broadcasts and sources switched off on purpose are not alerts.

export const LIMITS = {
  playableDropPct: 5,     // total playable episodes fell by more than this % (and by at least 5)…
  playableDropMin: 25,    // …or by at least this many
  sourceDropPct: 10,      // one source's working links fell by more than this %…
  sourceDropMin: 10,      // …and by at least this many links
  catalogDropPct: 5,      // Wikipedia catalog shrank by more than this %
};

const working = (s) => s.status !== 'broken';
export const isPlayable = (ep) => (ep?.sources ?? []).some(working);

function countBySource(data) {
  const counts = {};
  for (const ep of data?.episodes ?? []) for (const s of ep.sources) if (working(s)) counts[s.source] = (counts[s.source] ?? 0) + 1;
  return counts;
}

/**
 * @param prev   previous episodes.json (or null on the first run)
 * @param next   this run's output, with episode sources still carrying `_why` reasons
 * @param opts.problems  source failures reported by the run
 * @param opts.sources   config.sources (for ephemeral / switched-off sources)
 * @param opts.simulate  add a fake problem (to test alerts end to end)
 */
export function assessHealth(prev, next, { problems = [], sources = [], simulate = false } = {}) {
  const cfg = new Map(sources.map((s) => [s.id, s]));
  const expectedToVanish = (sourceId) => cfg.get(sourceId)?.ephemeral || cfg.get(sourceId)?.scrape === false;
  const alerts = [...problems];
  const lost = [];
  const recovered = [];

  if (simulate) alerts.push('Simulated alert (test run). Nothing is actually wrong.');

  if (prev) {
    const nextById = new Map(next.episodes.map((e) => [e.id, e]));
    for (const before of prev.episodes) {
      const after = nextById.get(before.id);
      const wasPlayable = isPlayable(before);
      const nowPlayable = isPlayable(after);
      if (wasPlayable && !nowPlayable) {
        const hadWorking = before.sources.filter(working);
        // Only expiring/switched-off sources kept it playable: that's expected, not an alert.
        if (hadWorking.every((s) => expectedToVanish(s.source))) continue;
        lost.push({
          id: before.id, code: before.code, title: before.title,
          links: hadWorking.map((s) => {
            const now = after?.sources.find((x) => x.url === s.url);
            return { source: s.source, url: s.url, why: now ? (now._why ?? 'marked broken') : 'no longer listed by the source', since: now?.since ?? null };
          }),
        });
      } else if (!wasPlayable && nowPlayable && before.sources.length) {
        recovered.push({ id: before.id, code: before.code, title: before.title });
      }
    }

    const p0 = prev.episodes.filter(isPlayable).length;
    const p1 = next.episodes.filter(isPlayable).length;
    const drop = p0 - p1;
    if (drop >= LIMITS.playableDropMin || (drop >= 5 && ((drop / p0) * 100 > LIMITS.playableDropPct))) {
      alerts.push(`Playable episodes dropped from ${p0} to ${p1}.`);
    }

    const c0 = countBySource(prev), c1 = countBySource(next);
    for (const [src, n0] of Object.entries(c0)) {
      if (expectedToVanish(src)) continue;
      const n1 = c1[src] ?? 0;
      if (n0 - n1 >= LIMITS.sourceDropMin && ((n0 - n1) / n0) * 100 > LIMITS.sourceDropPct) {
        alerts.push(`Working links from "${cfg.get(src)?.name ?? src}" dropped from ${n0} to ${n1}.`);
      }
    }

    const k0 = prev.episodes.filter((e) => !e.unlisted).length;
    const k1 = next.episodes.filter((e) => !e.unlisted).length;
    if (k0 && ((k0 - k1) / k0) * 100 > LIMITS.catalogDropPct) alerts.push(`The Wikipedia catalog shrank from ${k0} to ${k1} episodes.`);

    if ((prev.extras ?? []).length && !(next.extras ?? []).length) alerts.push('No podcast extras were found.');
  }

  const ok = alerts.length === 0 && lost.length === 0;
  return { ok, alerts, lost, recovered };
}

/** Markdown for the GitHub issue body / comment. */
export function healthMarkdown(h, { runUrl = null, date = new Date().toISOString().slice(0, 10) } = {}) {
  const lines = [];
  if (h.ok) {
    lines.push(`✅ ${date}: everything looks healthy again.`);
  } else {
    lines.push(`⚠️ ${date}: the nightly run found problems.`);
    if (h.alerts.length) lines.push('', '**Problems**', ...h.alerts.map((a) => `- ${a}`));
    if (h.lost.length) {
      lines.push('', `**Episodes no longer playable (${h.lost.length})**: every link failed, including any archive copy.`);
      for (const e of h.lost) {
        lines.push(`- ${e.code ? `#${e.code} ` : ''}${e.title}`);
        for (const l of e.links) lines.push(`  - ${l.source}: ${l.why}${l.since ? ` (since ${l.since})` : ''} ${l.url}`);
      }
    }
  }
  if (h.recovered.length) lines.push('', `**Playable again (${h.recovered.length})**`, ...h.recovered.map((e) => `- ${e.code ? `#${e.code} ` : ''}${e.title}`));
  if (runUrl) lines.push('', `Run: ${runUrl}`);
  return lines.join('\n') + '\n';
}
