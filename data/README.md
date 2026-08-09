# data

A committed copy of things that otherwise live only in one Google Sheet.

## decisions.csv

Every swipe Ashitha has made, exported from the `Decisions` tab. One row per
video, append-only, oldest first.

The sheet is the source of truth — the app writes to it after every swipe, and
the pull reads it back to drop videos already judged. This file is a backup, so
a lost or broken sheet does not take the whole swiping history with it.

Refresh it with:

    curl -s "https://katie-formats-app.vercel.app/api/sheets?action=readdecisions&full=1"

Columns: `When`, `VideoURL`, `Author`, `Topic`, `ContentType`,
`ScreenerVerdict`, `ScreenerReasons`, `Swipe`, `WhyKind`, `WhyReason`, `Views`,
`OutlierRatio`.

`ScreenerVerdict` against `Swipe` is the pair worth reading: it is what the
screener thought versus what Ashitha actually decided, and it is what a proposed
new rule should be replayed over before it goes live.
