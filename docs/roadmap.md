# Videothek — Roadmap

> Living document: the sequenced queue of phases. The hand-off to `/plan`, which
> picks the next phase, creates its spec + issues, and links them back here.
> No status markers — progress lives in the GitHub issues and milestones each
> phase links to. Specs (created by `/plan`) carry no lifecycle state either;
> a spec is "accepted" once merged on the default branch with a milestone and
> issues.

## Phase overview

| Phase | Name | Spec | Milestone |
|---|---|---|---|
| 1 | Foundation & accounts — project skeleton, config, router, static serving, SQLite + migrations, login/sessions, admin bootstrap, user admin UI, `npm run verify` | — | — |
| 2 | Library index: movies & series — scanner, movie/series parsers, direct-play compatibility table, watcher + periodic rescan, browse API + UI | — | — |
| 3 | Video streaming & player — path guard, range streaming (206/416), video player page | — | — |
| 4 | Progress & resume — progress API, player integration, "continue watching" | — | — |
| 5 | Music & audiobooks — ID3v2/FLAC tag readers, parsers, audio player with album/book queue and resume | — | — |
| 6 | Image gallery — folder gallery, EXIF embedded thumbnails, lightbox | — | — |

A phase gets a Spec link once `/plan` drafts it, and a Milestone link once the
spec is merged. The milestone (open/closed + issue progress) is where status
lives.

## North star

Every media file on the household disk opens in any browser on any device and
resumes exactly where it stopped — from one dependency-free process.
