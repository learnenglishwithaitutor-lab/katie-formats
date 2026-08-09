# Still to do

Open items for the Katie Formats approval app. Written down 2026-08-09 so they
survive between sessions.

## Learn from the swiping

- [ ] **Turn repeated rejections into rules.** When the same reason for
      rejecting comes up again and again, that is a screening rule waiting to be
      written. Spot the pattern and propose the rule, rather than leaving it to
      be noticed by hand.

- [ ] **Replay a proposed rule against past decisions before it goes live.** Run
      the new rule over videos already swiped and show what it would have done.
      A rule that would have thrown away things previously kept is a bad rule,
      and this is the only way to see that before it starts dropping real
      videos.

## See whether the screening is any good

- [ ] **Show a few dropped videos each run.** A sample of what was thrown away,
      surfaced every run, so a wrongly dropped video gets caught. Right now
      anything screened out is invisible and a bad rule could run for weeks
      unnoticed.

- [ ] **Show the rejection rate.** One number per run: how much was dropped. It
      is the quickest signal that screening has drifted — a sudden jump means a
      rule is too harsh, a drop to nothing means it stopped filtering.

## More creators

The full list, with notes and platform, is in `CREATORS.md`.

- [ ] **Add the four new TikTok candidates.** @englishwithemma_,
      @reallygoodenglishclasses, @rebeccas_english_hub, @mari.engliish. All four
      resolve, and TikTok needs no new code — it is a line each in `CREATORS`
      and a longer screening pass.

- [ ] **Instagram needs a second Apify actor.** One candidate waiting
      (@your.english.cheerleader). Reels report play counts, so the outlier
      ranking works unchanged; the work is a second actor and mapping its
      results into the same video record.

- [ ] **YouTube Shorts needs a second actor and its own transcripts.** One
      channel waiting (@POCEnglish) and one loose video. Harder than Instagram:
      the TikTok scrape hands over speech-to-text for free and YouTube does not,
      so the screener would be judging titles unless a transcript route is added.

- [ ] **Identify the loose YouTube short** `bh6wMVTkS3M` — a single video, not
      an account. Find whose channel it is before it can be tracked.

## Done

- [x] **Only show videos not yet swiped.** Done 2026-08-09. The Decisions tab
      always recorded every swipe, but nothing read it back, so each run rebuilt
      the deck from card one and adding one creator meant re-swiping every video
      from the old ones. The pull now reads the tab first and drops anything
      already judged — and stops with a plain message if the sheet cannot be
      read, rather than publishing a deck of repeats that looks normal.

- [x] **Facebook creators are not all being pulled.** Closed 2026-08-09, not
      fixed. Two of the three turned out to have TikTok accounts and were added
      there; the third was dropped. See `CREATORS.md`.

---

Note: an earlier count listed six open items. Only these five were recorded;
add the sixth here if it turns up.
