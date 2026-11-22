# Odyssey Episode Player

An unofficial fan web app that gathers publicly posted *Adventures in Odyssey* episodes into one list and plays them in the browser. It runs entirely on GitHub Pages:

- **No audio is hosted here.** The app only links to files published elsewhere.
- **No user data leaves the browser, and by default nothing is stored at all.** Progress, "last played" and source settings are kept in memory. Once there's something worth keeping, a save icon with a gold dot appears at the top right. It offers *Save and turn on autosave*, *Save just this once*, or *Not now*. *Not now* hides the dot for the rest of the visit. With autosave on, the icon becomes a green check that opens the saving settings. Saved data goes only to the visitor's `localStorage`, and **Settings → Your data** can turn autosave off or delete everything.

Not affiliated with or endorsed by Focus on the Family. *Adventures in Odyssey* is a trademark of Focus on the Family.

## How it works

```
Wikipedia list ─┐
dantan.net ─────┤   scraper (GitHub Action, nightly)          GitHub Pages
Official podcast┼─► collect → match → check links → build ─►  site/ + data/episodes.json
OnePlace RSS ───┘                                              (plays audio from the original hosts)
```

1. **Collect** (`scraper/sources/*`). Each source module turns one site into a common link format.
   - `wikipedia.js`: the master catalog (numbers, titles, seasons, albums) from the page's wikitext.
   - `dantan.js`: the fan-curated link list. Links are sorted by host into `subsplash`, `focus-legacy` and `wayback`. Dead hosts (an S3 staging bucket, expired CloudFront links, old Salem/OnePlace broadcast links) are skipped.
   - `omny.js`: the Official Podcast feed. Items titled "FREE EPISODE: …" become episode links, and everything else appears under **Podcast extras**. That tab works like the Episodes list (search, filter dropdown, collapsible groups), grouped by year with the oldest first.
   - `oneplace.js`: the last week of OnePlace broadcasts. These links expire, so earlier runs' links are kept until the checker confirms they're gone.
2. **Match** (`scraper/match.js`). Each link is attached to an episode, trying these in order: manual override, episode number checked against the title, exact title, then a close fuzzy title. A combined "split episode" broadcast (e.g. 428 = 428a + 428b) attaches to both halves.
3. **Check** (`scraper/check.js`). The checker requests the first byte of each file and requires an audio content type. A link becomes `broken` only after **two failed runs in a row**. Internet Archive links are checked weekly at low concurrency.
4. **Build.** The scraper writes `site/data/episodes.json` and `reports/match-report.md`. If a source fails entirely, its links from the previous run are reused, so the catalog never empties.

### Sources and defaults

| Source | Default | Notes |
|---|---|---|
| Focus on the Family (Subsplash) | On | Largest pool; official uploads |
| Official Podcast (Omny) | On | Free episodes only |
| OnePlace broadcast | On | Recent airings; links expire |
| Focus on the Family (older uploads) | On | Many are gone; the checker hides dead ones |
| Internet Archive (Wayback Machine) | **Off** | Archived copies of files that are no longer hosted; listeners can opt in |

Edit `config/sources.json` to change defaults. Set `"scrape": false` to drop a source entirely on the next run (for example, if a rights holder asks).

### In the player

- Listeners can turn sources on or off and reorder them in **Settings**. The player uses the highest-priority source that's on and not broken.
- If a link fails to load, or doesn't respond within 20 seconds, the player switches to the next source automatically and remembers the failure in that browser for 3 days.
- A "Playing from" menu lets listeners switch copies on the spot.
- Progress is saved **per copy**, because broadcast and album versions differ in length. When switching copies mid-episode, the position is converted proportionally.
- If the listener has saved, the app remembers the last episode. Reopening the site shows it paused at the spot where they stopped. Links like `#ep=aio-398` open a specific episode.

## Fixing matches

Read `reports/match-report.md` after a run. To fix a link, add it to `config/overrides.json`:

```json
{
  "links": {
    "https://cdn.subsplash.com/…/audio.mp3": "aio-398",
    "https://cdn.subsplash.com/…/combined.mp3": ["aio-438a", "aio-442a"],
    "https://example.com/not-an-episode.mp3": null
  }
}
```

Use `null` to ignore a link and a list to attach one file to several episodes.

## Running locally

```sh
npm ci
npm test
npm run scrape:quick       # collect + match, no link checks (about 20s)
npm run scrape -- --skip-wayback   # with link checks, except archive links
npm run serve              # http://localhost:3000
```

## Deploying

1. In the repository settings, go to **Pages → Build and deployment → Source** and choose **GitHub Actions**.
2. Merge to `main`. The `Update episodes and deploy` workflow deploys on every push, refreshes links nightly, and re-checks archive links on Sundays. You can also run it by hand from the **Actions** tab.

The workflow sends the repository URL as contact info in the scraper's `User-Agent`, as Wikimedia asks automated clients to do.
