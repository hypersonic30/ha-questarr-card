# Questarr Card

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
[![Home Assistant](https://img.shields.io/badge/Home%20Assistant-2024.8%2B-brightgreen.svg)](https://www.home-assistant.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A full-featured Home Assistant Lovelace dashboard card for
[Questarr](https://github.com/Doezer/Questarr) — browse and manage your game
library, discover new games, monitor downloads, search indexers, and more,
without leaving Home Assistant.

![Questarr Card preview](screenshot.png)

> [!IMPORTANT]
> This project consists of **two components** — both are required:
> - **[Questarr Integration](https://github.com/hypersonic30/ha-questarr-integration)** — backend proxy (install first)
> - **Questarr Card** (this repo) — the Lovelace frontend card

## Quick setup

1. Install and configure the [Questarr Integration](https://github.com/hypersonic30/ha-questarr-integration) first.
2. Install this card via HACS → Frontend (see [Installation](#installation) below).
3. Add it to a dashboard:
   ```yaml
   type: custom:questarr-card
   ```

No YAML is required to get started — every panel is on by default and can be
toggled from the visual card editor.

## Features

- **Stats header** — total/wanted/owned/shelved/downloading/completed counts, plus a notifications bell with unread badge.
- **Library** — search/filter your collection by status, change a game's status, rate it, hide it, or remove it. A detail view shows per-game downloads and blacklisted releases.
- **Discover** — browse IGDB popular/recent/upcoming titles, or filter by genre/platform, or search directly. Add anything straight to your library, or sync your Steam wishlist in one click.
- **Downloads** — see every active download across all your configured downloaders in one aggregated view, with pause/resume/remove, free-space chips per downloader, and a scan for untracked downloads with one-click claiming back into your library.
- **Indexer search** — search across all enabled indexers and grab a release directly, optionally linked to a specific library game.
- **RSS** — recent items from your configured feeds, with one-click "add to library".
- **xREL** — latest and searched scene/P2P game releases, annotated with your library status, with a shortcut into Indexer Search for anything not yet tracked by xREL itself (xREL only lists that a release exists — it doesn't provide a direct download).
- **Upcoming calendar** — release dates for your wanted games, computed entirely from already-loaded library data (no extra API calls).

Administrative settings — downloader/indexer credentials, SSL, IGDB/Discord/NexusMods API keys, path mapping, file browsing, logs — are intentionally **not** duplicated here. Manage those in Questarr's own web UI; this card is a dashboard, not a second settings page.

## Installation

### HACS (recommended)

1. HACS → Frontend → ⋮ → Custom repositories → add this repo's URL, category "Dashboard".
2. Install "Questarr Card".

### Manual

Copy `questarr-card.js` into your `config/www/` directory and add it as a dashboard resource:

```yaml
resources:
  - url: /local/questarr-card.js
    type: module
```

## Configuration

All options are available from the visual editor (the card's "Add Card" flow, or the pencil icon on an existing card). YAML reference:

```yaml
type: custom:questarr-card
title: "Questarr"
show_stats_header: true
show_notifications_bell: true
show_library: true
show_discover: true
show_downloads: true
show_indexer_search: true
show_rss: true
show_xrel: true
show_upcoming_calendar: true
show_nexusmods_widget: false
show_pcgamingwiki_widget: false
show_hltb_widget: false
library_page_size: 24
poll_interval: 30
fast_poll_interval: 5
default_tab: library
```

| Option | Description |
|---|---|
| `title` | Card header title. |
| `show_*` | Toggle individual panels/widgets on or off. |
| `library_page_size` | Games shown per page in the Library and Discover grids. |
| `poll_interval` | Seconds between refreshes of the header stats and whichever panel is active. |
| `fast_poll_interval` | Seconds between refreshes of the Downloads panel and the notification unread count, whenever either is relevant. |
| `default_tab` | Which panel is shown first (`library`, `discover`, `downloads`, `search`, `rss`, `xrel`, `calendar`). |

Data refreshes on a polling timer rather than push/websocket updates — Questarr's real-time channel (Socket.io) isn't proxied by the companion integration, so the card checks in periodically instead, same approach the wider *arr-stack dashboard ecosystem uses.

## Design notes

This card is a single, hand-written file with no build step and no runtime
dependencies — a deliberate choice given Questarr is one backend with one
data model (unlike multi-service dashboards that need a bundler to manage
many near-duplicate service integrations). That makes it easy to read, patch,
and review without installing any tooling.

No telemetry or analytics of any kind are collected by this card.

## License

MIT
