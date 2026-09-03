# SalesTeam — AI Sales Team for LinkedIn

A Chrome/Edge (Manifest V3) browser extension that turns LinkedIn's public Posts and Jobs search into an
automated, AI-assisted lead-generation pipeline for B2B sales — built for a real, working salesperson,
not as a demo.

Instead of manually re-running the same keyword searches every morning, you configure reusable **Topics**
once, click **Scan All Topics**, and get a single merged, deduplicated, relevance-ranked list of leads
across every topic — with noise (recruiters, job-seekers, competitors) automatically filtered out by
**Negative Topics**. From there, a small team of specialist AI agents helps you work the pipeline: prioritize
leads, draft outreach grounded in the lead's actual post, and pressure-test a message against a simulated
buyer persona before it ever reaches a real prospect.

## Why a browser extension, not a bot

Everything runs manually, inside the user's own already-authenticated LinkedIn session — there's no
scraped-credential risk, no headless automation, and no scheduled/background execution. It behaves like a
person clicking search, not a bot polling an API, which keeps it on the right side of LinkedIn's automation
policy.

## Features

- **Topics & Job Topics** — reusable keyword groups (with optional "AND with" conditions) searched across
  LinkedIn Posts and Jobs in one click, automatically chunked into multiple queries when a topic's keyword
  list is too long for a single search.
- **Negative Topics (lead filters)** — any lead matching one is marked "Irrelevant" instead of deleted,
  fully reversible on the Dashboard. Editing a filter can be re-applied to existing leads at any time,
  moving leads in *either* direction (New ↔ Irrelevant) without a new scan.
- **Dashboard** — a full-tab pipeline view: three pie charts (7 days / 30 days / all time) by status, a
  sortable/searchable/filterable leads table, AI-assisted priority scoring (P1–P5), and a "Bulk Change"
  dialog with confirmation and one-level undo.
- **Sales Assistant** — full pipeline agent: scans, filters, and prioritizes automatically after every scan.
- **Sales Mentor** — an AI agent for strategy questions ("which lead should I approach first?"), grounded in
  real lead data via tool calls rather than guessing.
- **Customer Voice** — a simulated buyer persona to bounce a draft message off before sending it for real.
- **Help** — an in-app FAQ with fuzzy, typo-tolerant free-text search (no AI call, no API key needed).
- **Export/Import & auto-backup** — full settings + lead-data backup as JSON, plus CSV export.

## Architecture

Vanilla JavaScript (ES modules), no build step, no external dependencies or remote code — everything runs
from the files in this repo.

| File | Responsibility |
|---|---|
| `manifest.json` | Extension configuration, permissions, entry points |
| `background.js` | Service worker: orchestrates scans (`scanAllTopics`), per-topic tab navigation, keepalive |
| `content-script.js` | Scrapes LinkedIn's Posts search-results page |
| `jobs-content-script.js` | Scrapes LinkedIn's Jobs search-results page |
| `storage.js` | All persisted state: topics, leads, statuses, settings, backups — via `chrome.storage.local` |
| `ranking.js` | Relevance scoring for merging results across topics |
| `agent-shared.js` | Shared Anthropic tool-use loop and lead-lookup tools, used by both the side panel and Dashboard |
| `sidepanel.js` / `sidepanel.html` / `sidepanel.css` | Main side panel — Topics, scan trigger, results |
| `dashboard.js` / `dashboard.html` / `dashboard.css` | Full-tab pipeline dashboard |
| `advisors.js` / `advisors.html` / `advisors.css` | Sales Mentor and Customer Voice chat UIs |
| `settings.js` / `settings.html` / `settings.css` | API key, templates, company context, output language |
| `help.js` / `help.html` / `help.css` | In-app FAQ and fuzzy search |

Each `.js` file also carries a short header comment describing what it does.

## Running it locally

1. `chrome://extensions` (or the Edge equivalent) → enable Developer mode → **Load unpacked** → select this
   folder.
2. Open the side panel, add a Topic or two, and click **Scan All Topics** while logged into LinkedIn.
3. Add an Anthropic API key in Settings to enable the Sales Mentor, Customer Voice, and AI message drafting.

## More documentation

- [`PRD.md`](PRD.md) — full product requirements / current-state spec
- [`Chrome Web Store Listing.md`](Chrome%20Web%20Store%20Listing.md) — store listing copy
- [`RELEASE_NOTES.md`](RELEASE_NOTES.md) — version history

## Note on this repo's contents

This repo intentionally excludes scraped lead data, full settings/lead backups, and any file found to
contain real LinkedIn users' names or contact details (see `.gitignore`) — those aren't code, and publishing
them would expose other people's personal information.
