# Creators

Who the pull scrapes, and who is waiting to be added. The live list is in
`CREATORS` at the top of `scripts/screen_run.py` — this file is the reasoning
behind it, and the queue of accounts Ashitha has sent but that are not in yet.

## Tracked now

Scraped on every run, 120 posts each, six-month window.

| Handle | Platform |
| --- | --- |
| [@wordy.adri](https://www.tiktok.com/@wordy.adri) | TikTok |
| [@learnwithmeera](https://www.tiktok.com/@learnwithmeera) | TikTok |
| [@learnativenglish](https://www.tiktok.com/@learnativenglish) | TikTok |
| [@englishwithevelyn](https://www.tiktok.com/@englishwithevelyn) | TikTok |

The last two were added 2026-08-09. Ashitha vetted them on Facebook first; these
are the same creators' TikTok accounts, so no second scraper was needed.

## Candidates, not yet vetted

Sent by Ashitha 2026-08-09. None of these are being scraped yet.

| Handle | Platform | Her note |
| --- | --- | --- |
| [@englishwithemma_](https://www.tiktok.com/@englishwithemma_) | TikTok | — |
| [@reallygoodenglishclasses](https://www.tiktok.com/@reallygoodenglishclasses) | TikTok | — |
| [@rebeccas_english_hub](https://www.tiktok.com/@rebeccas_english_hub) | TikTok | good, but too long |
| [@mari.engliish](https://www.tiktok.com/@mari.engliish) | TikTok | — |
| [@your.english.cheerleader](https://www.instagram.com/your.english.cheerleader/) | Instagram | fresh content, just needs to be made shorter |
| [@POCEnglish](https://www.youtube.com/@POCEnglish/shorts) | YouTube Shorts | — |
| [one short](https://youtube.com/shorts/bh6wMVTkS3M) | YouTube | a single video, not an account — find whose channel it is |

All four TikTok handles resolve. The four TikTok ones can go in today by adding
them to `CREATORS`; the run cost is a few more minutes of screening.

## Why platform matters

The pull is TikTok-only, and not by accident:

* **The Apify actor is a TikTok actor** (`GdWCkxBtKWOsKjdch` in `api/apify.js`).
  Instagram and YouTube each need a second actor and a second shape of result
  to be mapped into the same video record.
* **Ranking is views against a creator's own median.** A 20k-view post is a hit
  on a small account and a flop on a big one, so an absolute count would rank
  the biggest creator first every time. Any new platform has to report a per-post
  view count or its videos cannot be ranked — they can only be listed by date.
  Instagram reels do report plays. Facebook does not, which is why Facebook was
  dropped rather than solved.
* **Transcripts come free with the TikTok scrape.** TikTok hands over its own
  speech-to-text with each video, and screening reads that rather than the
  caption. Another platform needs its own transcript source, or the screener is
  judging a caption — far weaker evidence for what a video actually teaches.

So the order of work is: TikTok accounts first (free), then Instagram (a second
actor, ranking still works), then YouTube (a second actor, and its own
transcript route).

## Dropped

| Handle | Why |
| --- | --- |
| facebook.com/share/181nhF2pz1 | Ashitha dropped it 2026-08-09. Facebook blocks unauthenticated fetches, so the link could never be resolved to a page, profile or reel. |
