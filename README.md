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
   - `omny.js`: the Official Podcast. It reads Omny's full public listing for the show (every item back to 2006), falling back to the RSS feed, which only holds the latest 100, if the listing fails. Extras found on earlier runs are always kept, and extras are link-checked like episodes. Items titled "FREE EPISODE: …" become episode links, and everything else appears under **Podcast extras**. That tab works like the Episodes list (search, filter dropdown, collapsible groups), grouped by year with the oldest first.
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
- An ⓘ next to every episode and extra title (in the list and in the player) opens its **Sources**. Each place it can be played from is shown with its status and an **Open audio file ↗** link. Suspected broken links are hidden behind a "Show N suspected broken links" toggle in that popup.
- In Settings, each source has a ↗ next to its name linking to its official home, configured as `home` in `config/sources.json`.
- Progress is saved **per copy**, because broadcast and album versions differ in length. When switching copies mid-episode, the position is converted proportionally.
- Staying current: each deploy writes `version.json`. When the app returns to the foreground, and every 15 minutes, it compares that with its own version. If a newer one is live, it reloads itself, but only when nothing is playing, no dialog is open and no progress would be lost. It returns to the same tab, scroll position and episode. If there's unsaved progress (saving not turned on), it quietly stays on the current version. This matters most for iPhone Home Screen web apps, which are resumed rather than reloaded.
- If the listener has saved, the app remembers the last episode. Reopening the site shows it paused at the spot where they stopped. Links like `#ep=aio-398` open a specific episode.

## Alerts

After each nightly run, `scraper/health.js` compares the new data with the previous run:
- **Problems:** a source failed, playable episodes or one source's working links dropped sharply, the catalog shrank, or no podcast extras were found.
- **Lost episodes:** an episode that was playable and now has **no working link anywhere**, including the Internet Archive. Losing one of several copies doesn't count, and neither do expiring OnePlace broadcasts or sources switched off on purpose. Each lost episode is listed with the links that died and why.

If anything is wrong, `.github/scripts/alert.sh` opens a GitHub issue labelled `scraper-alert`, or comments on the one already open. It closes the issue once a run is healthy again, listing any episodes that became playable again. A crashed run or a failed deploy also files an alert. GitHub notifies you of the issue by email or in its app, depending on your notification settings. To test the whole path, run the workflow by hand with **Simulate an alert** ticked.

## Fixing matches: the Match review issue

Links that need a human decision are collected in one GitHub issue labelled `match-review`:
- links that matched no episode
- matches made by a guess
- episodes found in a source but not in Wikipedia's list
- links on unrecognised websites

The nightly run keeps the issue's list current, adds a comment only when new items appear, and closes it when nothing is left.

**To answer, tick a box** under an item. Each item offers ready-made choices, such as "✅ It's #467 Broken Window" or "🚫 Ignore this link". For anything else, **reply** with the item number and episode number, e.g. `3 is 467`. `ignore 3`, `accept 3` and `undo 3` also work. The **Match review answers** workflow (`.github/workflows/review.yml`) saves each decision to `config/overrides.json`, confirms in the issue and reruns the scraper. It only acts on the repository owner's own ticks and replies.

`config/overrides.json` can also be edited by hand:

```json
{
  "links": {
    "https://cdn.subsplash.com/…/audio.mp3": "aio-398",
    "https://cdn.subsplash.com/…/combined.mp3": ["aio-438a", "aio-442a"],
    "https://example.com/not-an-episode.mp3": null
  },
  "reviewed": ["https://example.com/fine-as-it-is.mp3"]
}
```

To test the issue end to end, run the deploy workflow by hand with **Add a test item to the Match review issue** ticked. Answering the test item changes nothing.

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
2. Merge to `main`. The `Update episodes and deploy` workflow deploys on every push, refreshes links nightly, and re-checks archive links on Sundays. You can also run it by hand from the **Actions** tab. Tick **Force a new app version** to make already-open apps reload even when nothing changed, which is useful for testing the auto-update.

The workflow sends the repository URL as contact info in the scraper's `User-Agent`, as Wikimedia asks automated clients to do.
