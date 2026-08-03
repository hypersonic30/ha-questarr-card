/*!
 * Questarr Card — a Home Assistant Lovelace card for Questarr
 * (https://github.com/Doezer/Questarr), a self-hosted, *arr-inspired
 * game-library manager.
 *
 * Requires the companion "Questarr" integration
 * (https://github.com/hypersonic30/ha-questarr-integration) to be installed
 * and configured first — it proxies this card's requests to your Questarr
 * instance so credentials never need to live in the browser.
 *
 * License: MIT
 */
"use strict";

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const CARD_VERSION = "0.3.0";
const CARD_TAG = "questarr-card";
const EDITOR_TAG = "questarr-card-editor";

const DEFAULT_CONFIG = {
  type: `custom:${CARD_TAG}`,
  title: "Questarr",
  show_stats_header: true,
  show_notifications_bell: true,
  show_library: true,
  show_discover: true,
  show_downloads: true,
  show_indexer_search: true,
  show_rss: true,
  show_xrel: true,
  show_upcoming_calendar: true,
  show_nexusmods_widget: false,
  show_pcgamingwiki_widget: false,
  show_hltb_widget: false,
  library_page_size: 24,
  poll_interval: 30,
  fast_poll_interval: 5,
  default_tab: "library",
};

// Order here also controls nav-tab order.
const PANELS = [
  { key: "library", label: "Library", configKey: "show_library" },
  { key: "discover", label: "Discover", configKey: "show_discover" },
  { key: "downloads", label: "Downloads", configKey: "show_downloads" },
  { key: "search", label: "Search", configKey: "show_indexer_search" },
  { key: "rss", label: "RSS", configKey: "show_rss" },
  { key: "xrel", label: "xREL", configKey: "show_xrel" },
  { key: "calendar", label: "Calendar", configKey: "show_upcoming_calendar" },
];

// Matches GAME_STATUSES / updateGameStatusSchema in Questarr's
// shared/schema.ts — the exact five values PATCH /api/games/:id/status accepts.
const GAME_STATUSES = ["wanted", "owned", "shelved", "downloading", "completed"];
const STATUS_LABELS = {
  wanted: "Wanted",
  owned: "Owned",
  shelved: "Shelved",
  downloading: "Downloading",
  completed: "Completed",
};

// ─────────────────────────────────────────────────────────────────────────
// Small utilities (no external dependencies, by design — see README)
// ─────────────────────────────────────────────────────────────────────────

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function qs(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let val = Number(n);
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// xREL.to's own API returns unix-epoch-seconds integers (time/pub_time),
// unlike Questarr's own DB timestamps which arrive as ISO strings once
// Express JSON-serializes a JS Date — hence the separate helper.
function fmtUnixSeconds(sec) {
  if (!sec) return "—";
  return fmtDate(new Date(sec * 1000).toISOString());
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// Best-effort extraction of a human-readable message from whatever shape
// hass.callApi()'s rejection takes — HA's exact thrown-error shape isn't
// part of any stable public contract, so this deliberately checks several
// plausible shapes rather than assuming one.
function errMessage(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (err.body) {
    if (typeof err.body === "string") return err.body;
    if (err.body.error) return err.body.error;
    if (err.body.message) return err.body.message;
  }
  if (err.error) return err.error;
  if (err.message) return err.message;
  return String(err);
}

// ─────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────

const STYLE = `
<style>
  * { box-sizing: border-box; }

  /* ── Design tokens ──────────────────────────────────────────────────
     Glassmorphism (frosted, translucent panels over a blurred backdrop),
     in the visual spirit of ha-arr-stack-card — but built from HA's own
     theme variables via color-mix() rather than hardcoded colors, so it
     adapts to whatever theme (light or dark) the dashboard is using
     instead of assuming a dark wallpaper is always behind it. Each
     color-mix() declaration has a plain rgba() fallback line before it
     for engines that don't support color-mix — the later, supported
     declaration simply wins the cascade where available. */
  :host {
    display: block;
    --qc-radius-lg: 26px;
    --qc-radius-md: 16px;
    --qc-radius-sm: 10px;
    --qc-blur: 26px;
    --qc-accent-rgb: 10, 132, 255;
    font-family: var(--paper-font-body1_-_font-family, -apple-system, "SF Pro Display", "Segoe UI", system-ui, sans-serif);
  }

  ha-card {
    position: relative;
    overflow: hidden;
    border-radius: var(--qc-radius-lg);
    background: rgba(128, 128, 128, 0.14);
    background: color-mix(in srgb, var(--card-background-color, #1c1c1e) 55%, transparent);
    backdrop-filter: blur(var(--qc-blur)) saturate(160%);
    -webkit-backdrop-filter: blur(var(--qc-blur)) saturate(160%);
    border: 1px solid rgba(128, 128, 128, 0.35);
    border: 1px solid color-mix(in srgb, var(--divider-color, #8e8e93) 55%, transparent);
    box-shadow: 0 20px 45px rgba(0, 0, 0, 0.16), inset 0 1px 1px rgba(255, 255, 255, 0.12);
  }
  /* Diagonal glass "sheen" highlight, same trick the reference card uses on
     its panels — a subtle light source from the top-left corner. */
  ha-card::before {
    content: "";
    position: absolute; inset: 0;
    background: linear-gradient(120deg, rgba(255, 255, 255, 0.30), rgba(255, 255, 255, 0.05) 35%, transparent 60%);
    opacity: 0.6;
    pointer-events: none;
  }

  .qc-root { position: relative; z-index: 1; display: flex; flex-direction: column; }

  .qc-error {
    display: flex; align-items: center; gap: 8px;
    margin: 14px 16px 0; padding: 10px 16px; border-radius: var(--qc-radius-sm);
    background: color-mix(in srgb, var(--error-color, #db4437) 80%, transparent);
    backdrop-filter: blur(10px);
    color: white; font-size: 0.9em;
  }
  .qc-error button {
    margin-left: auto; background: none; border: none; color: inherit;
    cursor: pointer; font-size: 1em; opacity: 0.8;
  }
  .qc-error button:hover { opacity: 1; }

  .qc-header { padding: 18px 20px 10px; }
  .qc-header-top { display: flex; align-items: center; gap: 8px; }
  .qc-title {
    font-size: 1.35em; font-weight: 700; letter-spacing: -0.01em;
    color: var(--primary-text-color);
    flex: 1;
  }
  .qc-bell {
    position: relative; border: none; cursor: pointer;
    color: var(--primary-text-color); width: 36px; height: 36px;
    border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: rgba(128, 128, 128, 0.12);
    background: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
    transition: background 0.15s ease;
  }
  .qc-bell:hover {
    background: rgba(128, 128, 128, 0.22);
    background: color-mix(in srgb, var(--primary-text-color) 16%, transparent);
  }
  .qc-bell-badge {
    position: absolute; top: -2px; right: -2px; background: var(--error-color, #db4437);
    color: white; border-radius: 999px; font-size: 0.65em; line-height: 1; font-weight: 700;
    padding: 3px 5px; min-width: 14px; text-align: center;
    box-shadow: 0 0 0 2px var(--card-background-color, transparent);
  }

  .qc-stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .qc-stat {
    display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
    padding: 8px 14px; border-radius: var(--qc-radius-sm);
    background: rgba(128, 128, 128, 0.10);
    background: color-mix(in srgb, var(--primary-text-color) 6%, transparent);
    border: 1px solid rgba(128, 128, 128, 0.14);
    border: 1px solid color-mix(in srgb, var(--divider-color) 40%, transparent);
  }
  .qc-stat-value { font-size: 1.3em; font-weight: 700; color: var(--primary-text-color); line-height: 1.1; }
  .qc-stat-label {
    font-size: 0.68em; color: var(--secondary-text-color); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
  }

  /* Segmented-pill nav, iOS/macOS-style, instead of an underlined tab bar */
  .qc-nav {
    display: flex; gap: 2px; margin: 14px 20px 0; padding: 4px;
    overflow-x: auto; border-radius: 999px;
    background: rgba(128, 128, 128, 0.10);
    background: color-mix(in srgb, var(--primary-text-color) 6%, transparent);
  }
  .qc-nav-btn {
    background: none; border: none; cursor: pointer; padding: 8px 14px;
    font-size: 0.85em; font-weight: 600; color: var(--secondary-text-color);
    white-space: nowrap; border-radius: 999px; transition: background 0.15s ease, color 0.15s ease;
  }
  .qc-nav-btn.active {
    color: white;
    background: rgb(var(--qc-accent-rgb));
    background: color-mix(in srgb, var(--primary-color, rgb(var(--qc-accent-rgb))) 92%, transparent);
    box-shadow: 0 2px 8px rgba(var(--qc-accent-rgb), 0.4);
  }

  .qc-panel { padding: 18px 20px 20px; }
  .qc-empty {
    padding: 28px 0; text-align: center; color: var(--secondary-text-color);
    font-size: 0.9em;
  }
  .qc-loading { padding: 28px 0; text-align: center; color: var(--secondary-text-color); }

  .qc-toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; align-items: center; }
  .qc-toolbar input[type="text"], .qc-toolbar input[type="search"], .qc-toolbar select {
    background: rgba(128, 128, 128, 0.10);
    background: color-mix(in srgb, var(--primary-text-color) 6%, transparent);
    color: var(--primary-text-color);
    border: 1px solid rgba(128, 128, 128, 0.16);
    border: 1px solid color-mix(in srgb, var(--divider-color) 45%, transparent);
    border-radius: 999px; padding: 7px 14px; font-size: 0.9em;
  }
  .qc-toolbar label { display: flex; align-items: center; gap: 4px; font-size: 0.85em; color: var(--secondary-text-color); }
  .qc-spacer { flex: 1; }

  .qc-btn {
    background: rgb(var(--qc-accent-rgb));
    background: color-mix(in srgb, var(--primary-color, rgb(var(--qc-accent-rgb))) 90%, transparent);
    color: white;
    border: none; border-radius: 999px; padding: 8px 16px; font-size: 0.85em; font-weight: 600;
    cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
    transition: transform 0.1s ease, box-shadow 0.15s ease;
    box-shadow: 0 2px 8px rgba(var(--qc-accent-rgb), 0.35);
  }
  .qc-btn:active { transform: scale(0.96); }
  .qc-btn:disabled { opacity: 0.5; cursor: default; transform: none; box-shadow: none; }
  .qc-btn.secondary {
    background: rgba(128, 128, 128, 0.12);
    background: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
    backdrop-filter: blur(8px);
    color: var(--primary-text-color);
    border: 1px solid rgba(128, 128, 128, 0.18);
    border: 1px solid color-mix(in srgb, var(--divider-color) 50%, transparent);
    box-shadow: none;
  }
  .qc-btn.danger {
    background: var(--error-color, #db4437);
    box-shadow: 0 2px 8px color-mix(in srgb, var(--error-color, #db4437) 40%, transparent);
  }
  .qc-btn.icon { padding: 8px; }

  .qc-badge {
    display: inline-block; padding: 3px 10px; border-radius: 999px;
    font-size: 0.7em; font-weight: 700; text-transform: capitalize; letter-spacing: 0.01em;
    background: rgba(128, 128, 128, 0.18);
    background: color-mix(in srgb, var(--primary-text-color) 12%, transparent);
    color: var(--primary-text-color);
  }
  .qc-badge.wanted { background: rgba(253, 216, 53, 0.28); color: #b28900; }
  .qc-badge.owned { background: rgba(67, 160, 71, 0.28); color: #2e8b32; }
  .qc-badge.shelved { background: rgba(142, 142, 147, 0.28); color: #6e6e73; }
  .qc-badge.downloading { background: rgba(30, 136, 229, 0.28); color: #1467b3; }
  .qc-badge.completed { background: rgba(142, 36, 170, 0.28); color: #9c27b0; }

  .qc-pagination { display: flex; gap: 8px; justify-content: center; margin-top: 14px; align-items: center; }

  .qc-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 14px;
  }
  .qc-game-card {
    position: relative; cursor: pointer; border-radius: var(--qc-radius-md); overflow: hidden;
    background: rgba(128, 128, 128, 0.10);
    background: color-mix(in srgb, var(--primary-text-color) 6%, transparent);
    border: 1px solid rgba(128, 128, 128, 0.14);
    border: 1px solid color-mix(in srgb, var(--divider-color) 35%, transparent);
    display: flex; flex-direction: column; text-align: left; padding: 0;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }
  .qc-game-card:hover {
    transform: translateY(-3px);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
  }
  .qc-card-art { position: relative; aspect-ratio: 3 / 4; overflow: hidden; background: var(--divider-color); }
  .qc-card-art img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .qc-card-noart {
    width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
    color: var(--secondary-text-color); font-size: 1.6em;
  }
  .qc-card-body { padding: 9px 10px; display: flex; flex-direction: column; gap: 5px; }
  .qc-card-title {
    font-size: 0.85em; font-weight: 600; color: var(--primary-text-color);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* Native <dialog>, shown via showModal(), is promoted to the browser's
     top layer — sized/positioned against the actual viewport regardless of
     any ancestor's transform/contain/scroll state. A hand-rolled
     position:fixed overlay looks identical on paper but silently breaks
     the moment an ancestor establishes its own containing block, which
     HA's sections/masonry views and view-transition animations do in
     practice — hence <dialog> instead of a div here. */
  .qc-dialog {
    padding: 0; border: none; background: transparent; color: inherit;
    max-width: none; max-height: none;
  }
  .qc-dialog::backdrop {
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .qc-modal {
    position: relative; overflow: hidden;
    background: rgba(40, 40, 40, 0.55);
    background: color-mix(in srgb, var(--card-background-color, #1c1c1e) 75%, transparent);
    backdrop-filter: blur(var(--qc-blur)) saturate(160%);
    -webkit-backdrop-filter: blur(var(--qc-blur)) saturate(160%);
    color: var(--primary-text-color);
    border-radius: var(--qc-radius-lg); width: min(640px, 92vw); max-height: 88vh;
    border: 1px solid rgba(128, 128, 128, 0.3);
    border: 1px solid color-mix(in srgb, var(--divider-color) 55%, transparent);
    box-shadow: 0 25px 60px rgba(0, 0, 0, 0.35);
  }
  .qc-modal-narrow { width: min(360px, 92vw); }
  .qc-modal-scroll { position: relative; z-index: 1; overflow-y: auto; max-height: 88vh; padding: 18px; }
  /* Blurred game cover behind the modal header — same "blurred poster as
     backdrop" trick the reference card uses for movie/show art. */
  .qc-modal-banner {
    position: absolute; inset: 0; z-index: 0;
    background-size: cover; background-position: center;
    filter: blur(30px) brightness(0.55) saturate(140%);
    transform: scale(1.15); /* hides the blur's soft edge from the container bounds */
  }
  .qc-modal-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .qc-modal-title { font-size: 1.25em; font-weight: 700; flex: 1; }
  .qc-modal-nav { margin: 0 0 14px 0; }
  .qc-modal-body { display: flex; flex-direction: column; gap: 12px; }
  .qc-modal-info { display: flex; gap: 16px; flex-wrap: wrap; }
  .qc-modal-cover { width: 140px; border-radius: var(--qc-radius-sm); object-fit: cover; box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35); }
  .qc-modal-meta { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 10px; }
  .qc-modal-summary { font-size: 0.9em; color: var(--secondary-text-color); margin: 0; }
  .qc-modal-facts { font-size: 0.85em; display: flex; flex-direction: column; gap: 2px; }
  .qc-modal-rating, .qc-modal-status-row, .qc-modal-actions {
    display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
  }

  .qc-table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  .qc-table th, .qc-table td {
    text-align: left; padding: 8px 10px;
    border-bottom: 1px solid rgba(128, 128, 128, 0.14);
    border-bottom: 1px solid color-mix(in srgb, var(--divider-color) 40%, transparent);
  }
  .qc-table tbody tr { transition: background 0.1s ease; }
  .qc-table tbody tr:hover {
    background: rgba(128, 128, 128, 0.08);
    background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
  }

  .qc-storage-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
  .qc-storage-chip {
    display: flex; align-items: center; gap: 5px; padding: 5px 12px; border-radius: 999px;
    background: rgba(128, 128, 128, 0.10);
    background: color-mix(in srgb, var(--primary-text-color) 6%, transparent);
    border: 1px solid rgba(128, 128, 128, 0.14);
    border: 1px solid color-mix(in srgb, var(--divider-color) 35%, transparent);
    font-size: 0.8em;
  }
  .qc-dl-name { font-size: 0.85em; margin-bottom: 4px; font-weight: 500; }
  .qc-progress {
    height: 5px; border-radius: 999px; overflow: hidden; width: 160px;
    background: rgba(128, 128, 128, 0.16);
    background: color-mix(in srgb, var(--primary-text-color) 10%, transparent);
  }
  .qc-progress-bar {
    height: 100%; border-radius: 999px;
    background: rgb(var(--qc-accent-rgb));
    background: color-mix(in srgb, var(--primary-color, rgb(var(--qc-accent-rgb))) 92%, transparent);
    box-shadow: 0 0 8px rgba(var(--qc-accent-rgb), 0.6);
  }
  .qc-scan-results {
    margin-bottom: 14px; border-radius: var(--qc-radius-sm); padding: 10px;
    border: 1px dashed rgba(128, 128, 128, 0.3);
    border: 1px dashed color-mix(in srgb, var(--divider-color) 55%, transparent);
  }
  .qc-scan-title { font-weight: 700; margin-bottom: 6px; font-size: 0.9em; }
  .qc-scan-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 0; font-size: 0.85em; }

  .qc-subnav { padding: 3px; margin: 0 0 12px; }

  .qc-rss-card { cursor: default; }
  .qc-rss-meta { font-size: 0.72em; color: var(--secondary-text-color); }

  .qc-xrel-list { display: flex; flex-direction: column; gap: 8px; }
  .qc-xrel-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 10px 14px; border-radius: var(--qc-radius-sm);
    background: rgba(128, 128, 128, 0.08);
    background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
    border: 1px solid rgba(128, 128, 128, 0.12);
    border: 1px solid color-mix(in srgb, var(--divider-color) 30%, transparent);
  }
  .qc-xrel-main { min-width: 0; }
  .qc-xrel-title { font-weight: 600; font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qc-xrel-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

  .qc-notif-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
  .qc-notif-row { display: flex; align-items: flex-start; gap: 8px; padding: 9px; border-radius: var(--qc-radius-sm); }
  .qc-notif-row.unread {
    background: rgba(128, 128, 128, 0.10);
    background: color-mix(in srgb, var(--primary-text-color) 7%, transparent);
  }
  .qc-notif-body { flex: 1; min-width: 0; }
  .qc-notif-title { font-weight: 700; font-size: 0.85em; }
  .qc-notif-message { font-size: 0.8em; color: var(--secondary-text-color); }

  .qc-calendar-list { display: flex; flex-direction: column; gap: 6px; }
  .qc-calendar-row {
    display: flex; align-items: center; gap: 12px; padding: 10px 14px;
    border-radius: var(--qc-radius-sm); border: none; cursor: pointer;
    background: rgba(128, 128, 128, 0.08);
    background: color-mix(in srgb, var(--primary-text-color) 5%, transparent);
    text-align: left; color: var(--primary-text-color); font: inherit; width: 100%;
    transition: background 0.1s ease;
  }
  .qc-calendar-row:hover {
    background: rgba(128, 128, 128, 0.14);
    background: color-mix(in srgb, var(--primary-text-color) 9%, transparent);
  }
  .qc-calendar-date { font-size: 0.8em; color: var(--secondary-text-color); min-width: 90px; }
  .qc-calendar-title { flex: 1; font-weight: 600; font-size: 0.9em; }

  /* === PANEL STYLES INSERTION POINT — do not remove this comment === */
</style>
`;

// ─────────────────────────────────────────────────────────────────────────
// Main card
// ─────────────────────────────────────────────────────────────────────────

class QuestarrCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this._config = { ...DEFAULT_CONFIG };
    this._hass = null;
    this._connected = false;
    this._skeletonReady = false;
    this._shellEl = null;
    this._gameDialogEl = null;
    this._notifDialogEl = null;
    this._activeTab = DEFAULT_CONFIG.default_tab;
    this._pollTimer = null;
    this._fastPollTimer = null;
    this._error = null;
    this._capabilities = null;

    // Stats / library
    this._games = [];
    this._gamesLoaded = false;
    this._libraryFilter = { search: "", status: "", includeHidden: false };
    this._libraryGames = [];
    this._libraryLoaded = false;
    this._selectedGameId = null;
    this._gameDownloads = [];
    this._gameBlacklist = [];
    this._gameDetailLoading = false;
    this._gameDetailTab = "info";

    // Discover
    this._discoverTab = "popular";
    this._discoverResults = [];
    this._discoverLoading = false;
    this._discoverSearchQuery = "";
    this._discoverGenres = [];
    this._discoverPlatforms = [];
    this._discoverGenreSel = "";
    this._discoverPlatformSel = "";
    this._steamSyncBusy = false;

    // Downloads
    this._downloads = [];
    this._downloadErrors = [];
    this._downloaderStorage = [];
    this._downloadScan = null;
    this._downloadScanLoading = false;

    // Indexer search
    this._searchQuery = "";
    this._searchResults = [];
    this._searchTotal = 0;
    this._searchLoading = false;
    this._searchError = null;
    this._searchLinkedGameId = "";

    // RSS
    this._rssFeeds = [];
    this._rssItems = [];
    this._rssLoading = false;

    // xREL
    this._xrelLatest = null;
    this._xrelPage = 1;
    this._xrelMode = "latest";
    this._xrelSearchQuery = "";
    this._xrelSearchResults = null;
    this._xrelSceneOnly = true;
    this._xrelP2p = false;
    this._xrelLoading = false;

    // Notifications
    this._notifications = [];
    this._unreadCount = 0;
    this._notifDropdownOpen = false;

    // Misc widgets / busy-state tracking
    this._nexusModsTrending = null;
    this._pcGamingWikiUrl = null;
    this._hltbResult = null;
    this._busyIds = new Set();
  }

  // ── HA lifecycle ────────────────────────────────────────────────────

  set hass(hass) {
    this._hass = hass;
  }

  get hass() {
    return this._hass;
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    this._config = { ...DEFAULT_CONFIG, ...config };

    const enabled = PANELS.filter((p) => this._config[p.configKey]);
    if (!enabled.find((p) => p.key === this._activeTab)) {
      this._activeTab = (enabled[0] || PANELS[0]).key;
    }

    if (this._connected) {
      this._startPolling();
      this._render();
    }
  }

  connectedCallback() {
    this._connected = true;
    this._ensureSkeleton();
    this.shadowRoot.addEventListener("click", this._handleClick);
    this.shadowRoot.addEventListener("input", this._handleInput);
    this.shadowRoot.addEventListener("change", this._handleChange);
    this.shadowRoot.addEventListener("submit", this._handleSubmit);
    this._render();
    this._fetchConfig();
    this._pollTick();
    this._startPolling();
  }

  disconnectedCallback() {
    this._connected = false;
    this._clearPolling();
    this.shadowRoot.removeEventListener("click", this._handleClick);
    this.shadowRoot.removeEventListener("input", this._handleInput);
    this.shadowRoot.removeEventListener("change", this._handleChange);
    this.shadowRoot.removeEventListener("submit", this._handleSubmit);
  }

  getCardSize() {
    const enabled = PANELS.filter((p) => this._config?.[p.configKey]).length;
    return 3 + enabled * 2;
  }

  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig() {
    return { ...DEFAULT_CONFIG };
  }

  // ── Delegated event handling ────────────────────────────────────────
  // Bound once via class-field arrow functions (stable references), so
  // add/removeEventListener in connected/disconnectedCallback always match.
  // Handlers are looked up by naming convention (`data-action="x"` ->
  // `_onAction_x`), so new panels only need to define a method with the
  // right name — no central dispatch table to keep in sync.

  _handleClick = (ev) => {
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    const handler = this[`_onAction_${el.dataset.action}`];
    if (typeof handler === "function") {
      ev.preventDefault();
      handler.call(this, el, ev);
    }
  };

  _handleInput = (ev) => {
    const el = ev.target.closest("[data-input]");
    if (!el) return;
    const handler = this[`_onInput_${el.dataset.input}`];
    if (typeof handler === "function") handler.call(this, el, ev);
  };

  _handleChange = (ev) => {
    const el = ev.target.closest("[data-change]");
    if (!el) return;
    const handler = this[`_onChange_${el.dataset.change}`];
    if (typeof handler === "function") handler.call(this, el, ev);
  };

  _handleSubmit = (ev) => {
    const el = ev.target.closest("[data-submit]");
    if (!el) return;
    ev.preventDefault();
    const handler = this[`_onSubmit_${el.dataset.submit}`];
    if (typeof handler === "function") handler.call(this, el, ev);
  };

  _onAction_dismissError() {
    this._error = null;
    this._render();
  }

  _onAction_switchTab(el) {
    this._activeTab = el.dataset.tab;
    this._render();
    this._fetchActivePanel();
  }

  _onAction_toggleNotifications() {
    this._notifDropdownOpen = !this._notifDropdownOpen;
    if (this._notifDropdownOpen && typeof this._fetchNotifications === "function") {
      this._fetchNotifications();
    }
    this._render();
  }

  // ── Networking ───────────────────────────────────────────────────────

  async _callApi(method, path, body) {
    try {
      return await this._hass.callApi(method, `questarr/${path}`, body);
    } catch (err) {
      if (err?.status === 401 && this._hass?.connection?.refreshAccessToken) {
        try {
          await this._hass.connection.refreshAccessToken();
        } catch (_) {
          // fall through and retry with whatever token we have anyway
        }
        return this._hass.callApi(method, `questarr/${path}`, body);
      }
      throw err;
    }
  }

  _setError(err, context) {
    const message = errMessage(err);
    this._error = context ? `${context}: ${message}` : message;
    console.error("[questarr-card]", context || "", err); // eslint-disable-line no-console
    this._render();
  }

  async _fetchConfig() {
    try {
      this._capabilities = await this._callApi("GET", "config");
    } catch (err) {
      this._setError(err, "Could not reach Questarr");
      return;
    }
    this._render();
  }

  // Deliberately a single unfiltered GET games call, not four separate
  // GET games/status/:status calls — cheaper, and also feeds the Library
  // panel's client-side status counts.
  async _fetchStats() {
    try {
      const games = await this._callApi("GET", "games");
      this._games = Array.isArray(games) ? games : [];
      this._gamesLoaded = true;
      this._error = null;
    } catch (err) {
      this._setError(err, "Could not load games");
      return;
    }
    this._render();
  }

  // ── Polling ──────────────────────────────────────────────────────────
  // Two tiers, mirroring the reference card's _interval/_fastInterval split:
  // a normal tier for the header stats + whichever panel is active, and a
  // fast tier for things that change quickly (download progress, unread
  // notification count) regardless of which panel is showing.

  _pollTick() {
    this._fetchStats();
    this._fetchActivePanel();
  }

  _fetchFastPanels() {
    if (this._config.show_notifications_bell && typeof this._fetchUnreadCount === "function") {
      this._fetchUnreadCount();
    }
    if (this._activeTab === "downloads" && typeof this._fetchDownloadsPanel === "function") {
      this._fetchDownloadsPanel();
    }
  }

  _fetchActivePanel() {
    switch (this._activeTab) {
      case "library":
        return typeof this._fetchLibrary === "function" ? this._fetchLibrary() : undefined;
      case "discover":
        return typeof this._fetchDiscoverActive === "function" ? this._fetchDiscoverActive() : undefined;
      case "downloads":
        return typeof this._fetchDownloadsPanel === "function" ? this._fetchDownloadsPanel() : undefined;
      case "rss":
        return typeof this._fetchRssPanel === "function" ? this._fetchRssPanel() : undefined;
      case "xrel":
        return typeof this._fetchXrelActive === "function" ? this._fetchXrelActive() : undefined;
      default:
        return undefined; // "search" and "calendar" are user-triggered / derived, not polled
    }
  }

  _startPolling() {
    this._clearPolling();
    const normalMs = Math.max(5, Number(this._config.poll_interval) || 30) * 1000;
    const fastMs = Math.max(2, Number(this._config.fast_poll_interval) || 5) * 1000;
    this._pollTimer = setInterval(() => this._pollTick(), normalMs);
    this._fastPollTimer = setInterval(() => this._fetchFastPanels(), fastMs);
  }

  _clearPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._fastPollTimer) clearInterval(this._fastPollTimer);
    this._pollTimer = null;
    this._fastPollTimer = null;
  }

  // ── Rendering ────────────────────────────────────────────────────────
  // Plain template-string innerHTML, re-rendered wholesale on every state
  // change — no virtual DOM, matching the "simplest to review, no build
  // step" goal. Focus/selection on the currently-focused input (e.g. a
  // search box) is preserved across re-renders via a data-focus-id round
  // trip, since a full innerHTML replace would otherwise steal focus.
  //
  // The game-detail modal and notifications popover are the one exception:
  // they live in persistent <dialog> elements built once by _ensureSkeleton()
  // rather than being torn down and rebuilt by every _render() call, and are
  // shown via showModal() rather than a hand-rolled position:fixed overlay.
  // A position:fixed div is normally sized/positioned against the viewport,
  // but that assumption breaks the moment any ancestor in the dashboard
  // establishes its own containing block (a CSS transform, `contain`, or
  // similar — which HA's sections/masonry views, view-transition animations,
  // and the iOS companion app's WebView all do in practice) — the popup then
  // gets sized/positioned against that ancestor's box instead of the actual
  // screen, which is exactly the "cut off" / "opens in the wrong place"
  // symptom this card hit. A native <dialog> shown via showModal() is
  // promoted to the browser's top layer, which is immune to all of that by
  // construction, regardless of any ancestor's CSS.

  _ensureSkeleton() {
    if (this._skeletonReady) return;
    this._skeletonReady = true;

    this.shadowRoot.innerHTML = `
      ${STYLE}
      <ha-card><div class="qc-root" id="qc-shell"></div></ha-card>
      <dialog class="qc-dialog"></dialog>
      <dialog class="qc-dialog"></dialog>
    `;
    this._shellEl = this.shadowRoot.getElementById("qc-shell");
    const dialogs = this.shadowRoot.querySelectorAll("dialog");
    this._gameDialogEl = dialogs[0];
    this._notifDialogEl = dialogs[1];

    this._wireDialogDismiss(this._gameDialogEl, () => {
      this._selectedGameId = null;
    });
    this._wireDialogDismiss(this._notifDialogEl, () => {
      this._notifDropdownOpen = false;
    });
  }

  // Standard native-<dialog> "light dismiss" pattern: a click that lands on
  // the dialog element itself (rather than bubbling from a descendant) means
  // it hit the backdrop margin, not the visible content box — MDN's own
  // <dialog> docs recommend exactly this rect check. The `close` event
  // covers every dismissal path uniformly (this click handler, the Escape
  // key, which the browser handles natively, or an explicit .close() call),
  // so app state only needs to be reconciled in one place.
  _wireDialogDismiss(dialog, onDismiss) {
    dialog.addEventListener("click", (ev) => {
      if (ev.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
      if (!inside) dialog.close();
    });
    dialog.addEventListener("close", () => {
      onDismiss();
      this._render();
    });
  }

  _render() {
    this._ensureSkeleton();
    const root = this.shadowRoot;
    const active = root.activeElement;
    const focusId = active?.dataset?.focusId;
    const selStart = active?.selectionStart;
    const selEnd = active?.selectionEnd;

    this._shellEl.innerHTML = this._renderShell();
    this._syncGameDialog();
    this._syncNotifDialog();

    if (focusId) {
      const el = root.querySelector(`[data-focus-id="${focusId}"]`);
      if (el) {
        el.focus();
        if (typeof selStart === "number" && typeof el.setSelectionRange === "function") {
          try {
            el.setSelectionRange(selStart, selEnd);
          } catch (_) {
            // not all input types support setSelectionRange (e.g. number) — harmless
          }
        }
      }
    }
  }

  _syncGameDialog() {
    const dialog = this._gameDialogEl;
    if (this._selectedGameId && typeof this._renderGameDetailModal === "function") {
      dialog.innerHTML = this._renderGameDetailModal();
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }

  _syncNotifDialog() {
    const dialog = this._notifDialogEl;
    if (this._notifDropdownOpen && typeof this._renderNotificationsDropdown === "function") {
      dialog.innerHTML = this._renderNotificationsDropdown();
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }

  _renderShell() {
    const errorHtml = this._error
      ? `<div class="qc-error"><ha-icon icon="mdi:alert-circle"></ha-icon><span>${esc(this._error)}</span><button data-action="dismissError">✕</button></div>`
      : "";

    return `
      ${errorHtml}
      ${this._renderHeader()}
      ${this._renderNav()}
      <div class="qc-panel">${this._renderActivePanel()}</div>
    `;
  }

  _renderHeader() {
    const counts = Object.fromEntries(GAME_STATUSES.map((s) => [s, 0]));
    for (const g of this._games) {
      if (counts[g.status] !== undefined) counts[g.status]++;
    }
    const total = this._games.length;

    const statsHtml = this._config.show_stats_header
      ? `
      <div class="qc-stats">
        <div class="qc-stat"><span class="qc-stat-value">${total}</span><span class="qc-stat-label">Total</span></div>
        ${GAME_STATUSES.map(
          (s) => `<div class="qc-stat"><span class="qc-stat-value">${counts[s]}</span><span class="qc-stat-label">${STATUS_LABELS[s]}</span></div>`
        ).join("")}
      </div>
    `
      : "";

    const bellHtml = this._config.show_notifications_bell
      ? `
      <button class="qc-bell" data-action="toggleNotifications" title="Notifications">
        <ha-icon icon="mdi:bell${this._unreadCount ? "" : "-outline"}"></ha-icon>
        ${this._unreadCount ? `<span class="qc-bell-badge">${this._unreadCount > 99 ? "99+" : this._unreadCount}</span>` : ""}
      </button>
    `
      : "";

    return `
      <div class="qc-header">
        <div class="qc-header-top">
          <div class="qc-title">${esc(this._config.title || "Questarr")}</div>
          ${bellHtml}
        </div>
        ${statsHtml}
      </div>
    `;
  }

  _renderNav() {
    const enabled = PANELS.filter((p) => this._config[p.configKey]);
    if (enabled.length < 2) return "";
    return `
      <div class="qc-nav">
        ${enabled
          .map(
            (p) => `
          <button class="qc-nav-btn ${this._activeTab === p.key ? "active" : ""}" data-action="switchTab" data-tab="${p.key}">
            ${esc(p.label)}
          </button>
        `
          )
          .join("")}
      </div>
    `;
  }

  _renderActivePanel() {
    switch (this._activeTab) {
      case "library":
        return typeof this._renderLibraryPanel === "function" ? this._renderLibraryPanel() : this._renderComingSoon("Library");
      case "discover":
        return typeof this._renderDiscoverPanel === "function" ? this._renderDiscoverPanel() : this._renderComingSoon("Discover");
      case "downloads":
        return typeof this._renderDownloadsPanel === "function" ? this._renderDownloadsPanel() : this._renderComingSoon("Downloads");
      case "search":
        return typeof this._renderIndexerSearchPanel === "function" ? this._renderIndexerSearchPanel() : this._renderComingSoon("Search");
      case "rss":
        return typeof this._renderRssPanel === "function" ? this._renderRssPanel() : this._renderComingSoon("RSS");
      case "xrel":
        return typeof this._renderXrelPanel === "function" ? this._renderXrelPanel() : this._renderComingSoon("xREL");
      case "calendar":
        return typeof this._renderUpcomingCalendar === "function" ? this._renderUpcomingCalendar() : this._renderComingSoon("Calendar");
      default:
        return "";
    }
  }

  _renderComingSoon(name) {
    return `<div class="qc-empty">${esc(name)} panel is not available.</div>`;
  }

  // ── Library: fetch ───────────────────────────────────────────────────

  async _fetchLibrary() {
    try {
      const games = await this._callApi(
        "GET",
        `games${qs({
          search: this._libraryFilter.search || undefined,
          status: this._libraryFilter.status || undefined,
          includeHidden: this._libraryFilter.includeHidden ? "true" : undefined,
        })}`
      );
      this._libraryGames = Array.isArray(games) ? games : [];
      this._libraryLoaded = true;
    } catch (err) {
      this._setError(err, "Could not load library");
      return;
    }
    this._render();
  }

  async _fetchGameDetail(id) {
    this._gameDetailLoading = true;
    this._render();
    try {
      const [downloads, blacklist] = await Promise.all([
        this._callApi("GET", `games/${id}/downloads`).catch(() => []),
        this._callApi("GET", `games/${id}/blacklist`).catch(() => []),
      ]);
      this._gameDownloads = Array.isArray(downloads) ? downloads : [];
      this._gameBlacklist = Array.isArray(blacklist) ? blacklist : [];
    } finally {
      this._gameDetailLoading = false;
      this._render();
    }
  }

  // Looks across every already-fetched list rather than issuing a dedicated
  // "get one game" call — Questarr's API doesn't expose GET /api/games/:id,
  // only list/search/status endpoints, so the modal reuses whatever list the
  // user navigated from (library, discover, xREL annotations, ...).
  _getGame(id) {
    return (
      this._games.find((g) => g.id === id) ||
      this._libraryGames.find((g) => g.id === id) ||
      (this._discoverResults || []).find((g) => g.id === id)
    );
  }

  // ── Library: actions ─────────────────────────────────────────────────

  _onAction_openGame(el) {
    const id = el.dataset.id;
    this._selectedGameId = id;
    this._gameDetailTab = "info";
    this._render();
    this._fetchGameDetail(id);
  }

  _onAction_closeGameDetail() {
    this._selectedGameId = null;
    this._render();
  }

  _onAction_switchGameDetailTab(el) {
    this._gameDetailTab = el.dataset.tab;
    this._render();
  }

  async _onAction_setStatus(el) {
    const { id, status } = el.dataset;
    if (this._busyIds.has(id)) return;
    this._busyIds.add(id);
    this._render();
    try {
      await this._callApi("PATCH", `games/${id}/status`, { status });
      await Promise.all([this._fetchStats(), this._activeTab === "library" ? this._fetchLibrary() : null]);
    } catch (err) {
      this._setError(err, "Could not update status");
    } finally {
      this._busyIds.delete(id);
      this._render();
    }
  }

  async _onAction_setHidden(el) {
    const { id, hidden } = el.dataset;
    try {
      await this._callApi("PATCH", `games/${id}/hidden`, { hidden: hidden === "true" });
      await this._fetchLibrary();
    } catch (err) {
      this._setError(err, "Could not update visibility");
    }
  }

  async _onAction_setRating(el) {
    const { id } = el.dataset;
    const rating = Number(el.dataset.rating);
    try {
      await this._callApi("PATCH", `games/${id}/user-rating`, { userRating: rating });
      await this._fetchGameDetail(id);
    } catch (err) {
      this._setError(err, "Could not update rating");
    }
  }

  async _onAction_deleteGame(el) {
    const { id } = el.dataset;
    const name = el.dataset.title || "this game";
    if (!window.confirm(`Remove "${name}" from your library? This cannot be undone.`)) return;
    try {
      await this._callApi("DELETE", `games/${id}`);
      if (this._selectedGameId === id) this._selectedGameId = null;
      await Promise.all([this._fetchStats(), this._fetchLibrary()]);
    } catch (err) {
      this._setError(err, "Could not delete game");
    }
  }

  async _onAction_refreshMetadata() {
    try {
      await this._callApi("POST", "games/refresh-metadata");
      await this._fetchLibrary();
    } catch (err) {
      this._setError(err, "Could not refresh metadata");
    }
  }

  async _onAction_deleteGameDownload(el) {
    const { id, downloadId } = el.dataset;
    if (!window.confirm("Remove this download?")) return;
    try {
      await this._callApi("DELETE", `games/${id}/downloads/${downloadId}`);
      await this._fetchGameDetail(id);
    } catch (err) {
      this._setError(err, "Could not remove download");
    }
  }

  async _onSubmit_addBlacklist(el) {
    const gameId = el.dataset.id;
    const input = el.querySelector('input[name="releaseTitle"]');
    const releaseTitle = input?.value?.trim();
    if (!releaseTitle) return;
    try {
      await this._callApi("POST", `games/${gameId}/blacklist`, { releaseTitle });
      input.value = "";
      await this._fetchGameDetail(gameId);
    } catch (err) {
      this._setError(err, "Could not add blacklist entry");
    }
  }

  async _onAction_deleteBlacklist(el) {
    const { id, blacklistId } = el.dataset;
    try {
      await this._callApi("DELETE", `games/${id}/blacklist/${blacklistId}`);
      await this._fetchGameDetail(id);
    } catch (err) {
      this._setError(err, "Could not remove blacklist entry");
    }
  }

  // ── Library: input handlers ──────────────────────────────────────────

  _onInput_librarySearch(el) {
    this._libraryFilter.search = el.value;
    if (!this._debouncedFetchLibrary) {
      this._debouncedFetchLibrary = debounce(() => this._fetchLibrary(), 400);
    }
    this._debouncedFetchLibrary();
  }

  _onChange_libraryStatus(el) {
    this._libraryFilter.status = el.value;
    this._fetchLibrary();
  }

  _onChange_libraryIncludeHidden(el) {
    this._libraryFilter.includeHidden = el.checked;
    this._fetchLibrary();
  }

  // ── Library: render ───────────────────────────────────────────────────

  _renderLibraryPanel() {
    if (!this._libraryLoaded) return `<div class="qc-loading">Loading library…</div>`;

    const toolbar = `
      <div class="qc-toolbar">
        <input type="search" placeholder="Search library…" data-input="librarySearch"
               data-focus-id="library-search" value="${esc(this._libraryFilter.search)}" />
        <select data-change="libraryStatus">
          <option value="" ${!this._libraryFilter.status ? "selected" : ""}>All statuses</option>
          ${GAME_STATUSES.map(
            (s) => `<option value="${s}" ${this._libraryFilter.status === s ? "selected" : ""}>${STATUS_LABELS[s]}</option>`
          ).join("")}
        </select>
        <label><input type="checkbox" data-change="libraryIncludeHidden" ${this._libraryFilter.includeHidden ? "checked" : ""} /> Show hidden</label>
        <span class="qc-spacer"></span>
        <button class="qc-btn secondary" data-action="refreshMetadata">Refresh metadata</button>
      </div>
    `;

    if (!this._libraryGames.length) {
      return toolbar + `<div class="qc-empty">No games match this filter.</div>`;
    }

    const pageSize = Math.max(6, Number(this._config.library_page_size) || 24);
    const shown = this._libraryGames.slice(0, pageSize);

    return `
      ${toolbar}
      <div class="qc-grid">${shown.map((g) => this._renderGameCard(g)).join("")}</div>
      ${
        this._libraryGames.length > pageSize
          ? `<div class="qc-empty">Showing ${shown.length} of ${this._libraryGames.length} — refine your search to narrow this down.</div>`
          : ""
      }
    `;
  }

  _renderGameCard(game) {
    const cover = game.coverUrl
      ? `<img src="${esc(game.coverUrl)}" alt="" loading="lazy" />`
      : `<div class="qc-card-noart"><ha-icon icon="mdi:controller-classic"></ha-icon></div>`;
    // Discover results have status: null (formatGameData in Questarr's own
    // server/igdb.ts) since they aren't in the library yet — show no badge
    // rather than an empty pill in that case.
    const badge = game.status ? `<span class="qc-badge ${esc(game.status)}">${STATUS_LABELS[game.status] || esc(game.status)}</span>` : "";
    return `
      <button class="qc-game-card" data-action="openGame" data-id="${esc(game.id)}">
        <div class="qc-card-art">${cover}</div>
        <div class="qc-card-body">
          <div class="qc-card-title" title="${esc(game.title)}">${esc(game.title)}</div>
          ${badge}
        </div>
      </button>
    `;
  }

  _renderGameDetailModal() {
    const game = this._getGame(this._selectedGameId);
    if (!game) {
      return `
        <div class="qc-modal">
          <div class="qc-modal-scroll"><div class="qc-loading">Loading…</div></div>
        </div>
      `;
    }

    const tabs = [
      { key: "info", label: "Info" },
      { key: "downloads", label: `Downloads (${this._gameDownloads.length})` },
      { key: "blacklist", label: `Blacklist (${this._gameBlacklist.length})` },
    ];
    const tabBtns = tabs
      .map(
        (t) => `
        <button class="qc-nav-btn ${this._gameDetailTab === t.key ? "active" : ""}" data-action="switchGameDetailTab" data-tab="${t.key}">
          ${esc(t.label)}
        </button>
      `
      )
      .join("");

    let body;
    if (this._gameDetailLoading) {
      body = `<div class="qc-loading">Loading…</div>`;
    } else if (this._gameDetailTab === "downloads") {
      body = this._renderGameDownloadsTab(game);
    } else if (this._gameDetailTab === "blacklist") {
      body = this._renderGameBlacklistTab(game);
    } else {
      body = this._renderGameInfoTab(game);
    }

    const bannerHtml = game.coverUrl
      ? `<div class="qc-modal-banner" style="background-image:url('${esc(game.coverUrl)}')"></div>`
      : "";

    return `
      <div class="qc-modal">
        ${bannerHtml}
        <div class="qc-modal-scroll">
          <div class="qc-modal-header">
            <div class="qc-modal-title">${esc(game.title)}</div>
            <button class="qc-btn icon secondary" data-action="closeGameDetail"><ha-icon icon="mdi:close"></ha-icon></button>
          </div>
          <div class="qc-nav qc-modal-nav">${tabBtns}</div>
          <div class="qc-modal-body">${body}</div>
        </div>
      </div>
    `;
  }

  _renderGameInfoTab(game) {
    // Questarr's IGDB formatter (server/igdb.ts formatGameData) explicitly
    // sets status: null for discover results that aren't in the library yet
    // — library rows always have a real status string. Reuse that signal to
    // decide which action set to show, since Library/Discover/xREL panels
    // all funnel through this same modal.
    const inLibrary = game.status != null;
    const cover = game.coverUrl ? `<img class="qc-modal-cover" src="${esc(game.coverUrl)}" alt="" />` : "";

    const facts = `
      <div class="qc-modal-facts">
        ${game.releaseDate ? `<div><strong>Release date:</strong> ${fmtDate(game.releaseDate)}</div>` : ""}
        ${game.rating != null ? `<div><strong>IGDB rating:</strong> ${esc(game.rating)}</div>` : ""}
        ${Array.isArray(game.platforms) && game.platforms.length ? `<div><strong>Platforms:</strong> ${esc(game.platforms.join(", "))}</div>` : ""}
        ${Array.isArray(game.genres) && game.genres.length ? `<div><strong>Genres:</strong> ${esc(game.genres.join(", "))}</div>` : ""}
      </div>
    `;

    let actions;
    if (inLibrary) {
      const statusButtons = GAME_STATUSES.map(
        (s) => `
          <button class="qc-btn ${game.status === s ? "" : "secondary"}" data-action="setStatus"
                  data-id="${esc(game.id)}" data-status="${s}" ${this._busyIds.has(game.id) ? "disabled" : ""}>
            ${STATUS_LABELS[s]}
          </button>
        `
      ).join("");
      const ratingButtons = [2, 4, 6, 8, 10]
        .map(
          (r) => `
          <button class="qc-btn icon ${game.userRating === r ? "" : "secondary"}" data-action="setRating"
                  data-id="${esc(game.id)}" data-rating="${r}">${r}</button>
        `
        )
        .join("");
      actions = `
        <div class="qc-modal-rating"><strong>Your rating:</strong>${ratingButtons}</div>
        <div class="qc-modal-status-row">${statusButtons}</div>
        <div class="qc-modal-actions">
          <button class="qc-btn secondary" data-action="setHidden" data-id="${esc(game.id)}" data-hidden="${game.hidden ? "false" : "true"}">
            ${game.hidden ? "Unhide" : "Hide"}
          </button>
          <button class="qc-btn danger" data-action="deleteGame" data-id="${esc(game.id)}" data-title="${esc(game.title)}">
            Remove from library
          </button>
        </div>
      `;
    } else {
      actions = `
        <div class="qc-modal-actions">
          <button class="qc-btn" data-action="addToLibrary" data-id="${esc(game.id)}" ${this._busyIds.has(game.id) ? "disabled" : ""}>
            <ha-icon icon="mdi:plus"></ha-icon> Add to library
          </button>
        </div>
      `;
    }

    return `
      <div class="qc-modal-info">
        ${cover}
        <div class="qc-modal-meta">
          ${game.summary ? `<p class="qc-modal-summary">${esc(game.summary)}</p>` : ""}
          ${facts}
          ${actions}
        </div>
      </div>
    `;
  }

  _renderGameDownloadsTab(game) {
    // These are GameDownload rows (Questarr's own tracking records — id,
    // downloadTitle, status, fileSize, errorMessage, addedAt/completedAt),
    // not the live per-downloader progress feed — that lives on the
    // Downloads panel's aggregated DownloadStatus objects instead.
    if (!this._gameDownloads.length) return `<div class="qc-empty">No downloads tracked for this game yet.</div>`;
    return `
      <table class="qc-table">
        <thead><tr><th>Title</th><th>Status</th><th>Size</th><th>Added</th><th></th></tr></thead>
        <tbody>
          ${this._gameDownloads
            .map(
              (d) => `
            <tr>
              <td>${esc(d.downloadTitle)}</td>
              <td>${esc(d.status)}${d.errorMessage ? ` <ha-icon icon="mdi:alert" title="${esc(d.errorMessage)}"></ha-icon>` : ""}</td>
              <td>${fmtBytes(d.fileSize)}</td>
              <td>${fmtDate(d.addedAt)}</td>
              <td>
                <button class="qc-btn danger icon" data-action="deleteGameDownload"
                        data-id="${esc(game.id)}" data-download-id="${esc(d.id)}">
                  <ha-icon icon="mdi:delete"></ha-icon>
                </button>
              </td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  _renderGameBlacklistTab(game) {
    const rows = this._gameBlacklist.length
      ? `
        <table class="qc-table">
          <thead><tr><th>Release title</th><th></th></tr></thead>
          <tbody>
            ${this._gameBlacklist
              .map(
                (b) => `
              <tr>
                <td>${esc(b.releaseTitle)}</td>
                <td>
                  <button class="qc-btn danger icon" data-action="deleteBlacklist"
                          data-id="${esc(game.id)}" data-blacklist-id="${esc(b.id)}">
                    <ha-icon icon="mdi:delete"></ha-icon>
                  </button>
                </td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      `
      : `<div class="qc-empty">No blacklisted releases for this game.</div>`;

    return `
      ${rows}
      <form class="qc-toolbar" data-submit="addBlacklist" data-id="${esc(game.id)}">
        <input type="text" name="releaseTitle" placeholder="Release title to blacklist…" />
        <button type="submit" class="qc-btn">Add</button>
      </form>
    `;
  }

  // ── Downloads: fetch ─────────────────────────────────────────────────

  async _fetchDownloadsPanel() {
    try {
      const data = await this._callApi("GET", "downloads");
      this._downloads = Array.isArray(data?.downloads) ? data.downloads : [];
      this._downloadErrors = Array.isArray(data?.errors) ? data.errors : [];
    } catch (err) {
      this._setError(err, "Could not load downloads");
      return;
    }
    try {
      const storage = await this._callApi("GET", "downloaders/storage");
      this._downloaderStorage = Array.isArray(storage) ? storage : [];
    } catch (_) {
      // Non-critical for the panel to function — keep whatever we had.
    }
    this._render();
  }

  // ── Downloads: actions ───────────────────────────────────────────────

  async _downloadAction(downloaderId, downloadId, method, path, errCtx) {
    const key = `${downloaderId}:${downloadId}`;
    if (this._busyIds.has(key)) return;
    this._busyIds.add(key);
    this._render();
    try {
      await this._callApi(method, path);
      await this._fetchDownloadsPanel();
    } catch (err) {
      this._setError(err, errCtx);
    } finally {
      this._busyIds.delete(key);
      this._render();
    }
  }

  _onAction_pauseDownload(el) {
    const { downloaderId, downloadId } = el.dataset;
    return this._downloadAction(
      downloaderId, downloadId, "POST",
      `downloaders/${downloaderId}/downloads/${downloadId}/pause`, "Could not pause download"
    );
  }

  _onAction_resumeDownload(el) {
    const { downloaderId, downloadId } = el.dataset;
    return this._downloadAction(
      downloaderId, downloadId, "POST",
      `downloaders/${downloaderId}/downloads/${downloadId}/resume`, "Could not resume download"
    );
  }

  _onAction_deleteDownload(el) {
    const { downloaderId, downloadId } = el.dataset;
    if (!window.confirm("Remove this download?")) return undefined;
    return this._downloadAction(
      downloaderId, downloadId, "DELETE",
      `downloaders/${downloaderId}/downloads/${downloadId}`, "Could not remove download"
    );
  }

  async _onAction_scanDownloads() {
    this._downloadScanLoading = true;
    this._render();
    try {
      this._downloadScan = await this._callApi("GET", "downloads/scan");
    } catch (err) {
      this._setError(err, "Could not scan for untracked downloads");
    } finally {
      this._downloadScanLoading = false;
      this._render();
    }
  }

  async _onAction_claimDownload(el) {
    const { downloaderId, downloadHash, downloadTitle, currentStatus, category, gameId } = el.dataset;
    try {
      await this._callApi("POST", "downloads/claim", {
        downloaderId,
        downloadHash,
        downloadTitle,
        currentStatus: currentStatus || "downloading",
        category: category || "main",
        gameId: gameId || undefined,
      });
      await Promise.all([this._onAction_scanDownloads(), this._fetchStats(), this._fetchDownloadsPanel()]);
    } catch (err) {
      this._setError(err, "Could not claim download");
    }
  }

  // ── Downloads: render ────────────────────────────────────────────────

  _renderDownloadsPanel() {
    const storageHtml = this._downloaderStorage.length
      ? `
      <div class="qc-storage-row">
        ${this._downloaderStorage
          .map(
            (s) => `
          <div class="qc-storage-chip" title="${s.error ? esc(s.error) : ""}">
            <ha-icon icon="mdi:harddisk"></ha-icon>
            <span>${esc(s.downloaderName)}: ${s.error ? "—" : fmtBytes(s.freeSpace)} free</span>
          </div>
        `
          )
          .join("")}
      </div>
    `
      : "";

    const errorsHtml = this._downloadErrors.length
      ? `<div class="qc-empty">${this._downloadErrors
          .map((e) => `⚠️ ${esc(e.downloaderName || e.name || "A downloader")}: ${esc(e.error || e.message || "error")}`)
          .join("<br/>")}</div>`
      : "";

    const toolbar = `
      <div class="qc-toolbar">
        <span class="qc-spacer"></span>
        <button class="qc-btn secondary" data-action="scanDownloads" ${this._downloadScanLoading ? "disabled" : ""}>
          ${this._downloadScanLoading ? "Scanning…" : "Scan for untracked downloads"}
        </button>
      </div>
    `;

    const scanHtml = this._downloadScan ? this._renderDownloadScan() : "";

    if (!this._downloads.length) {
      return storageHtml + toolbar + scanHtml + `<div class="qc-empty">No active downloads.</div>`;
    }

    return `
      ${storageHtml}
      ${errorsHtml}
      ${toolbar}
      ${scanHtml}
      <table class="qc-table qc-downloads-table">
        <thead><tr><th>Name</th><th>Progress</th><th>Speed</th><th>ETA</th><th>Source</th><th></th></tr></thead>
        <tbody>${this._downloads.map((d) => this._renderDownloadRow(d)).join("")}</tbody>
      </table>
    `;
  }

  _renderDownloadRow(d) {
    const busyKey = `${d.downloaderId}:${d.id}`;
    const busy = this._busyIds.has(busyKey);
    const isPaused = d.status === "paused";
    const pct = Math.max(0, Math.min(100, Math.round(Number(d.progress) || 0)));
    const speed = d.downloadSpeed ? `↓ ${fmtBytes(d.downloadSpeed)}/s` : "";
    const upSpeed = d.uploadSpeed ? ` ↑ ${fmtBytes(d.uploadSpeed)}/s` : "";
    const eta = d.eta ? `${Math.round(d.eta / 60)} min` : "—";

    return `
      <tr>
        <td>
          <div class="qc-dl-name">${esc(d.name)}</div>
          <div class="qc-progress"><div class="qc-progress-bar" style="width:${pct}%"></div></div>
        </td>
        <td>${pct}% <span class="qc-badge">${esc(d.status)}</span></td>
        <td>${esc(speed)}${esc(upSpeed)}</td>
        <td>${esc(eta)}</td>
        <td>${esc(d.downloaderName)}${d.trackedByQuestarr ? "" : ` <span title="Not linked to a library game">·</span>`}</td>
        <td>
          <button class="qc-btn icon secondary" data-action="${isPaused ? "resumeDownload" : "pauseDownload"}"
                  data-downloader-id="${esc(d.downloaderId)}" data-download-id="${esc(d.id)}" ${busy ? "disabled" : ""}>
            <ha-icon icon="${isPaused ? "mdi:play" : "mdi:pause"}"></ha-icon>
          </button>
          <button class="qc-btn icon danger" data-action="deleteDownload"
                  data-downloader-id="${esc(d.downloaderId)}" data-download-id="${esc(d.id)}" ${busy ? "disabled" : ""}>
            <ha-icon icon="mdi:delete"></ha-icon>
          </button>
        </td>
      </tr>
    `;
  }

  _renderDownloadScan() {
    const groups = this._downloadScan?.groups || [];
    if (!groups.length) return `<div class="qc-empty">No untracked downloads found.</div>`;
    return `
      <div class="qc-scan-results">
        <div class="qc-scan-title">Untracked downloads</div>
        ${groups
          .map((g) => {
            const first = (g.downloads && g.downloads[0]) || {};
            const match = g.libraryMatch && g.libraryMatch.game;
            return `
              <div class="qc-scan-row">
                <div>${esc(g.baseTitle)} <span class="qc-badge">${(g.downloads || []).length} file(s)</span></div>
                ${
                  match
                    ? `
                  <button class="qc-btn" data-action="claimDownload"
                          data-downloader-id="${esc(first.downloaderId)}"
                          data-download-hash="${esc(first.hash || first.id || "")}"
                          data-download-title="${esc(first.name || g.baseTitle)}"
                          data-current-status="${esc(first.status || "downloading")}"
                          data-category="main" data-game-id="${esc(match.id)}">
                    Claim to "${esc(match.title)}"
                  </button>
                `
                    : `<span class="qc-badge">no library match — add the game, then re-scan</span>`
                }
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  // ── Discover: fetch ──────────────────────────────────────────────────

  _fetchDiscoverActive() {
    switch (this._discoverTab) {
      case "recent":
        return this._fetchDiscoverList("recent");
      case "upcoming":
        return this._fetchDiscoverList("upcoming");
      case "genre":
        return this._discoverGenreSel ? this._fetchDiscoverList("genre", this._discoverGenreSel) : undefined;
      case "platform":
        return this._discoverPlatformSel ? this._fetchDiscoverList("platform", this._discoverPlatformSel) : undefined;
      case "search":
        return this._discoverSearchQuery ? this._fetchDiscoverSearch(this._discoverSearchQuery) : undefined;
      default:
        return this._fetchDiscoverList("popular");
    }
  }

  async _fetchDiscoverList(kind, param) {
    this._discoverLoading = true;
    this._render();
    try {
      const path =
        kind === "genre"
          ? `igdb/genre/${encodeURIComponent(param)}`
          : kind === "platform"
            ? `igdb/platform/${encodeURIComponent(param)}`
            : `igdb/${kind}`;
      const games = await this._callApi("GET", `${path}${qs({ limit: 24 })}`);
      this._discoverResults = Array.isArray(games) ? games : [];
    } catch (err) {
      this._setError(err, "Could not load discover results");
    } finally {
      this._discoverLoading = false;
      this._render();
    }
  }

  async _fetchDiscoverSearch(q) {
    this._discoverLoading = true;
    this._render();
    try {
      const games = await this._callApi("GET", `igdb/search${qs({ q, limit: 24 })}`);
      this._discoverResults = Array.isArray(games) ? games : [];
    } catch (err) {
      this._setError(err, "Could not search IGDB");
    } finally {
      this._discoverLoading = false;
      this._render();
    }
  }

  async _ensureDiscoverTaxonomies() {
    if (this._discoverGenres.length && this._discoverPlatforms.length) return;
    try {
      const [genres, platforms] = await Promise.all([
        this._callApi("GET", "igdb/genres"),
        this._callApi("GET", "igdb/platforms"),
      ]);
      this._discoverGenres = Array.isArray(genres) ? genres : [];
      this._discoverPlatforms = Array.isArray(platforms) ? platforms : [];
    } catch (err) {
      this._setError(err, "Could not load genres/platforms");
    }
    this._render();
  }

  // ── Discover: actions ────────────────────────────────────────────────

  _onAction_switchDiscoverTab(el) {
    this._discoverTab = el.dataset.tab;
    this._discoverResults = [];
    this._render();
    if (this._discoverTab === "genre" || this._discoverTab === "platform") {
      this._ensureDiscoverTaxonomies();
    }
    this._fetchDiscoverActive();
  }

  // Uses POST /api/games directly with the IGDB metadata we already have in
  // hand (title/igdbId/cover/etc from formatGameData), rather than
  // POST /api/games/match-and-add — that endpoint is for the opposite case,
  // where only a plain title string is known and Questarr must guess the
  // IGDB match server-side (used by the RSS/xREL panels instead).
  async _onAction_addToLibrary(el) {
    const id = el.dataset.id;
    const game = this._getGame(id);
    if (!game || this._busyIds.has(id)) return;
    this._busyIds.add(id);
    this._render();
    try {
      await this._callApi("POST", "games", {
        title: game.title,
        igdbId: game.igdbId,
        summary: game.summary || undefined,
        coverUrl: game.coverUrl || undefined,
        releaseDate: game.releaseDate || undefined,
        rating: game.rating != null ? game.rating : undefined,
        platforms: game.platforms,
        genres: game.genres,
        publishers: game.publishers,
        developers: game.developers,
      });
      await this._fetchStats();
      if (this._activeTab === "library") await this._fetchLibrary();
      this._selectedGameId = null;
    } catch (err) {
      this._setError(err, "Could not add game to library");
    } finally {
      this._busyIds.delete(id);
      this._render();
    }
  }

  async _onAction_syncSteamWishlist() {
    if (this._steamSyncBusy) return;
    this._steamSyncBusy = true;
    this._render();
    try {
      const res = await this._callApi("POST", "steam/wishlist/sync");
      const added = res?.addedCount ?? 0;
      this._error = null;
      console.info(`[questarr-card] Steam wishlist sync added ${added} game(s)`); // eslint-disable-line no-console
      await this._fetchStats();
    } catch (err) {
      this._setError(err, "Could not sync Steam wishlist — is a Steam ID linked in Questarr's settings?");
    } finally {
      this._steamSyncBusy = false;
      this._render();
    }
  }

  _onChange_discoverGenre(el) {
    this._discoverGenreSel = el.value;
    if (el.value) this._fetchDiscoverList("genre", el.value);
    else {
      this._discoverResults = [];
      this._render();
    }
  }

  _onChange_discoverPlatform(el) {
    this._discoverPlatformSel = el.value;
    if (el.value) this._fetchDiscoverList("platform", el.value);
    else {
      this._discoverResults = [];
      this._render();
    }
  }

  _onSubmit_discoverSearch(el) {
    const input = el.querySelector('input[name="q"]');
    const q = input?.value?.trim();
    this._discoverSearchQuery = q || "";
    if (q) this._fetchDiscoverSearch(q);
  }

  // ── Discover: render ─────────────────────────────────────────────────

  _renderDiscoverPanel() {
    const tabs = [
      { key: "popular", label: "Popular" },
      { key: "recent", label: "Recent" },
      { key: "upcoming", label: "Upcoming" },
      { key: "genre", label: "By genre" },
      { key: "platform", label: "By platform" },
      { key: "search", label: "Search" },
    ];
    const tabBtns = tabs
      .map(
        (t) => `
        <button class="qc-nav-btn ${this._discoverTab === t.key ? "active" : ""}" data-action="switchDiscoverTab" data-tab="${t.key}">
          ${esc(t.label)}
        </button>
      `
      )
      .join("");

    let controls = "";
    if (this._discoverTab === "genre") {
      controls = `
        <div class="qc-toolbar">
          <select data-change="discoverGenre">
            <option value="">Select a genre…</option>
            ${this._discoverGenres
              .map((g) => `<option value="${esc(g.name)}" ${this._discoverGenreSel === g.name ? "selected" : ""}>${esc(g.name)}</option>`)
              .join("")}
          </select>
        </div>
      `;
    } else if (this._discoverTab === "platform") {
      controls = `
        <div class="qc-toolbar">
          <select data-change="discoverPlatform">
            <option value="">Select a platform…</option>
            ${this._discoverPlatforms
              .map((p) => `<option value="${esc(p.name)}" ${this._discoverPlatformSel === p.name ? "selected" : ""}>${esc(p.name)}</option>`)
              .join("")}
          </select>
        </div>
      `;
    } else if (this._discoverTab === "search") {
      controls = `
        <form class="qc-toolbar" data-submit="discoverSearch">
          <input type="search" name="q" placeholder="Search for a game…" data-focus-id="discover-search" value="${esc(this._discoverSearchQuery)}" />
          <button type="submit" class="qc-btn">Search</button>
        </form>
      `;
    }

    let body;
    if (this._discoverLoading) {
      body = `<div class="qc-loading">Loading…</div>`;
    } else if (!this._discoverResults.length) {
      const hint =
        this._discoverTab === "genre" && !this._discoverGenreSel
          ? "Choose a genre above."
          : this._discoverTab === "platform" && !this._discoverPlatformSel
            ? "Choose a platform above."
            : this._discoverTab === "search" && !this._discoverSearchQuery
              ? "Search for a game above."
              : "No results.";
      body = `<div class="qc-empty">${hint}</div>`;
    } else {
      body = `<div class="qc-grid">${this._discoverResults.map((g) => this._renderGameCard(g)).join("")}</div>`;
    }

    return `
      <div class="qc-nav qc-subnav">${tabBtns}</div>
      <div class="qc-toolbar">
        <span class="qc-spacer"></span>
        <button class="qc-btn secondary" data-action="syncSteamWishlist" ${this._steamSyncBusy ? "disabled" : ""}>
          ${this._steamSyncBusy ? "Syncing…" : "Sync Steam wishlist"}
        </button>
      </div>
      ${controls}
      ${body}
    `;
  }

  // ── Indexer search: fetch ────────────────────────────────────────────

  async _fetchIndexerSearch(query) {
    this._searchLoading = true;
    this._searchError = null;
    this._render();
    try {
      const data = await this._callApi("GET", `indexers/search${qs({ query, limit: 50 })}`);
      this._searchResults = Array.isArray(data?.items) ? data.items : [];
      this._searchTotal = data?.total ?? this._searchResults.length;
      if (Array.isArray(data?.errors) && data.errors.length) {
        this._searchError = data.errors.join(", ");
      }
    } catch (err) {
      this._setError(err, "Indexer search failed");
    } finally {
      this._searchLoading = false;
      this._render();
    }
  }

  // ── Indexer search: actions ──────────────────────────────────────────
  // "Grab" is shared with the xREL panel (task 11 reuses this same handler).

  _onSubmit_indexerSearch(el) {
    const input = el.querySelector('input[name="query"]');
    const query = input?.value?.trim();
    this._searchQuery = query || "";
    if (query) this._fetchIndexerSearch(query);
  }

  _onChange_searchLinkGame(el) {
    this._searchLinkedGameId = el.value;
    this._render();
  }

  async _onAction_grabRelease(el) {
    const { link, title, gameId } = el.dataset;
    const key = `grab:${link}`;
    if (this._busyIds.has(key)) return;
    this._busyIds.add(key);
    this._render();
    try {
      await this._callApi("POST", "downloads", {
        url: link,
        title,
        gameId: gameId || undefined,
      });
    } catch (err) {
      this._setError(err, "Could not start download from that release");
    } finally {
      this._busyIds.delete(key);
      this._render();
    }
  }

  // ── Indexer search: render ───────────────────────────────────────────

  _renderIndexerSearchPanel() {
    const gameOptions = this._games
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((g) => `<option value="${esc(g.id)}" ${this._searchLinkedGameId === g.id ? "selected" : ""}>${esc(g.title)}</option>`)
      .join("");

    return `
      <form class="qc-toolbar" data-submit="indexerSearch">
        <input type="search" name="query" placeholder="Search indexers…" data-focus-id="indexer-search" value="${esc(this._searchQuery)}" />
        <button type="submit" class="qc-btn" ${this._searchLoading ? "disabled" : ""}>
          ${this._searchLoading ? "Searching…" : "Search"}
        </button>
      </form>
      <div class="qc-toolbar">
        <label>
          Link grabbed releases to:
          <select data-change="searchLinkGame">
            <option value="">Not linked to a game</option>
            ${gameOptions}
          </select>
        </label>
      </div>
      ${this._renderIndexerSearchResults()}
    `;
  }

  _renderIndexerSearchResults() {
    if (this._searchLoading) return `<div class="qc-loading">Searching…</div>`;
    if (!this._searchResults.length) {
      return `<div class="qc-empty">${this._searchQuery ? "No results." : "Search for a release above."}</div>`;
    }
    return `
      ${this._searchError ? `<div class="qc-empty">⚠️ ${esc(this._searchError)}</div>` : ""}
      <table class="qc-table">
        <thead><tr><th>Title</th><th>Indexer</th><th>Size</th><th>Seeds/Peers</th><th>Published</th><th></th></tr></thead>
        <tbody>${this._searchResults.map((r) => this._renderSearchResultRow(r)).join("")}</tbody>
      </table>
    `;
  }

  _renderSearchResultRow(r) {
    const key = `grab:${r.link}`;
    const busy = this._busyIds.has(key);
    return `
      <tr>
        <td>${esc(r.title)}</td>
        <td>${esc(r.indexerName || "—")}</td>
        <td>${fmtBytes(r.size)}</td>
        <td>${r.seeders != null ? `${r.seeders} / ${r.leechers ?? 0}` : "—"}</td>
        <td>${fmtDate(r.pubDate)}</td>
        <td>
          <button class="qc-btn icon" data-action="grabRelease" data-link="${esc(r.link)}" data-title="${esc(r.title)}"
                  data-game-id="${esc(this._searchLinkedGameId || "")}" ${busy ? "disabled" : ""} title="Grab this release">
            <ha-icon icon="mdi:download"></ha-icon>
          </button>
        </td>
      </tr>
    `;
  }

  // ── RSS: fetch ────────────────────────────────────────────────────────

  async _fetchRssPanel() {
    try {
      const [feeds, items] = await Promise.all([
        this._callApi("GET", "rss/feeds"),
        this._callApi("GET", `rss/items${qs({ limit: 50 })}`),
      ]);
      this._rssFeeds = Array.isArray(feeds) ? feeds : [];
      this._rssItems = Array.isArray(items) ? items : [];
    } catch (err) {
      this._setError(err, "Could not load RSS feeds");
      return;
    }
    this._render();
  }

  // ── RSS: actions ──────────────────────────────────────────────────────

  async _onAction_refreshRss() {
    if (this._rssLoading) return;
    this._rssLoading = true;
    this._render();
    try {
      await this._callApi("POST", "rss/refresh");
      await this._fetchRssPanel();
    } catch (err) {
      this._setError(err, "Could not refresh RSS feeds");
    } finally {
      this._rssLoading = false;
      this._render();
    }
  }

  // RSS items only carry a title/guessed IGDB name, not full IGDB metadata —
  // POST /api/games/match-and-add lets Questarr resolve the IGDB match
  // server-side, unlike Discover's direct POST /api/games (which already has
  // the full IGDB record in hand). Same reasoning applies to the xREL panel.
  async _onAction_addRssItem(el) {
    const { title, id } = el.dataset;
    const key = `rss-add:${id}`;
    if (this._busyIds.has(key)) return;
    this._busyIds.add(key);
    this._render();
    try {
      await this._callApi("POST", "games/match-and-add", { title });
      await this._fetchStats();
    } catch (err) {
      this._setError(err, "Could not add game from RSS item");
    } finally {
      this._busyIds.delete(key);
      this._render();
    }
  }

  // ── RSS: render ───────────────────────────────────────────────────────

  _renderRssPanel() {
    const feedsHtml = this._rssFeeds.length
      ? `
      <div class="qc-storage-row">
        ${this._rssFeeds
          .map(
            (f) => `
          <div class="qc-storage-chip" title="${f.errorMessage ? esc(f.errorMessage) : ""}">
            <ha-icon icon="mdi:rss"></ha-icon>
            <span>${esc(f.name)}${f.status === "error" ? " ⚠️" : ""}</span>
          </div>
        `
          )
          .join("")}
      </div>
    `
      : `<div class="qc-empty">No RSS feeds configured — add some in Questarr's own Settings.</div>`;

    const toolbar = `
      <div class="qc-toolbar">
        <span class="qc-spacer"></span>
        <button class="qc-btn secondary" data-action="refreshRss" ${this._rssLoading ? "disabled" : ""}>
          ${this._rssLoading ? "Refreshing…" : "Refresh feeds"}
        </button>
      </div>
    `;

    const itemsHtml = this._rssItems.length
      ? `<div class="qc-grid">${this._rssItems.map((it) => this._renderRssItem(it)).join("")}</div>`
      : `<div class="qc-empty">No RSS items yet.</div>`;

    return `${feedsHtml}${toolbar}${itemsHtml}`;
  }

  _renderRssItem(item) {
    const key = `rss-add:${item.id}`;
    const busy = this._busyIds.has(key);
    const cover = item.coverUrl
      ? `<img src="${esc(item.coverUrl)}" alt="" loading="lazy" />`
      : `<div class="qc-card-noart"><ha-icon icon="mdi:rss"></ha-icon></div>`;
    const displayTitle = item.igdbGameName || item.title;
    return `
      <div class="qc-game-card qc-rss-card">
        <a class="qc-card-art" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">${cover}</a>
        <div class="qc-card-body">
          <div class="qc-card-title" title="${esc(item.title)}">${esc(displayTitle)}</div>
          <div class="qc-rss-meta">${esc(item.sourceName || "")} · ${fmtDate(item.pubDate)}</div>
          <button class="qc-btn secondary" data-action="addRssItem" data-id="${esc(item.id)}" data-title="${esc(displayTitle)}" ${busy ? "disabled" : ""}>
            Add to library
          </button>
        </div>
      </div>
    `;
  }

  // ── xREL: fetch ───────────────────────────────────────────────────────

  _fetchXrelActive() {
    return this._xrelMode === "search" && this._xrelSearchQuery
      ? this._fetchXrelSearch(this._xrelSearchQuery)
      : this._fetchXrelLatest(this._xrelPage);
  }

  async _fetchXrelLatest(page) {
    this._xrelLoading = true;
    this._render();
    try {
      this._xrelLatest = await this._callApi("GET", `xrel/latest${qs({ page })}`);
      this._xrelPage = page || 1;
      this._xrelMode = "latest";
    } catch (err) {
      this._setError(err, "Could not load xREL releases");
    } finally {
      this._xrelLoading = false;
      this._render();
    }
  }

  async _fetchXrelSearch(query) {
    this._xrelLoading = true;
    this._render();
    try {
      const data = await this._callApi(
        "GET",
        `xrel/search${qs({ q: query, scene: this._xrelSceneOnly, p2p: this._xrelP2p, limit: 25 })}`
      );
      this._xrelSearchResults = Array.isArray(data?.results) ? data.results : [];
      this._xrelMode = "search";
    } catch (err) {
      this._setError(err, "xREL search failed");
    } finally {
      this._xrelLoading = false;
      this._render();
    }
  }

  // ── xREL: actions ─────────────────────────────────────────────────────

  _onSubmit_xrelSearch(el) {
    const input = el.querySelector('input[name="q"]');
    const q = input?.value?.trim();
    this._xrelSearchQuery = q || "";
    if (q) this._fetchXrelSearch(q);
  }

  _onChange_xrelSceneToggle(el) {
    this._xrelSceneOnly = el.checked;
  }

  _onChange_xrelP2pToggle(el) {
    this._xrelP2p = el.checked;
  }

  _onAction_xrelShowLatest() {
    this._xrelMode = "latest";
    this._xrelSearchResults = null;
    this._render();
    this._fetchXrelLatest(this._xrelPage);
  }

  _onAction_xrelPage(el) {
    this._fetchXrelLatest(Number(el.dataset.page) || 1);
  }

  async _onAction_addXrelRelease(el) {
    const { title, id } = el.dataset;
    const key = `xrel-add:${id}`;
    if (this._busyIds.has(key)) return;
    this._busyIds.add(key);
    this._render();
    try {
      await this._callApi("POST", "games/match-and-add", { title });
      await this._fetchStats();
    } catch (err) {
      this._setError(err, "Could not add game from xREL release");
    } finally {
      this._busyIds.delete(key);
      this._render();
    }
  }

  // xREL only catalogs that a scene/P2P release exists (dirname + an xrel.to
  // web link) — it never hands back a torrent/nzb URL, so there's nothing to
  // "grab" directly. The useful action is handing the release name to the
  // Indexer Search panel so the user can find an actual downloadable copy.
  _onAction_xrelSearchIndexers(el) {
    if (!this._config.show_indexer_search) return;
    const query = el.dataset.query;
    this._activeTab = "search";
    this._searchQuery = query;
    this._render();
    this._fetchIndexerSearch(query);
  }

  // ── xREL: render ──────────────────────────────────────────────────────

  _renderXrelPanel() {
    const searchForm = `
      <form class="qc-toolbar" data-submit="xrelSearch">
        <input type="search" name="q" placeholder="Search xREL…" data-focus-id="xrel-search" value="${esc(this._xrelSearchQuery)}" />
        <label><input type="checkbox" data-change="xrelSceneToggle" ${this._xrelSceneOnly ? "checked" : ""} /> Scene</label>
        <label><input type="checkbox" data-change="xrelP2pToggle" ${this._xrelP2p ? "checked" : ""} /> P2P</label>
        <button type="submit" class="qc-btn">Search</button>
        ${this._xrelMode === "search" ? `<button type="button" class="qc-btn secondary" data-action="xrelShowLatest">Back to latest</button>` : ""}
      </form>
    `;

    if (this._xrelLoading) return searchForm + `<div class="qc-loading">Loading…</div>`;

    if (this._xrelMode === "search") {
      const results = this._xrelSearchResults || [];
      return (
        searchForm +
        (results.length
          ? `<div class="qc-xrel-list">${results.map((r) => this._renderXrelRow(r)).join("")}</div>`
          : `<div class="qc-empty">No results.</div>`)
      );
    }

    const list = this._xrelLatest?.list || [];
    const pagination = this._xrelLatest?.pagination;
    return `
      ${searchForm}
      ${
        list.length
          ? `<div class="qc-xrel-list">${list.map((r) => this._renderXrelRow(r)).join("")}</div>`
          : `<div class="qc-empty">No releases found.</div>`
      }
      ${
        pagination
          ? `
        <div class="qc-pagination">
          <button class="qc-btn secondary" data-action="xrelPage" data-page="${Math.max(1, pagination.current_page - 1)}"
                  ${pagination.current_page <= 1 ? "disabled" : ""}>Prev</button>
          <span>Page ${pagination.current_page} / ${pagination.total_pages}</span>
          <button class="qc-btn secondary" data-action="xrelPage" data-page="${pagination.current_page + 1}"
                  ${pagination.current_page >= pagination.total_pages ? "disabled" : ""}>Next</button>
        </div>
      `
          : ""
      }
    `;
  }

  _renderXrelRow(r) {
    const title = r.ext_info?.title || r.dirname;
    const inLibrary = !!r.gameId;
    const game = inLibrary ? this._getGame(r.gameId) : null;
    const addKey = `xrel-add:${r.id}`;
    const busy = this._busyIds.has(addKey);

    const actionHtml = inLibrary
      ? game
        ? `<button class="qc-btn secondary" data-action="openGame" data-id="${esc(game.id)}">${esc(STATUS_LABELS[game.status] || "In library")}</button>`
        : `<span class="qc-badge">In library</span>`
      : `<button class="qc-btn secondary" data-action="addXrelRelease" data-id="${esc(r.id)}" data-title="${esc(title)}" ${busy ? "disabled" : ""}>Add to library</button>`;

    const searchBtn = this._config.show_indexer_search
      ? `
      <button class="qc-btn icon secondary" data-action="xrelSearchIndexers" data-query="${esc(r.dirname)}" title="Search indexers for this release">
        <ha-icon icon="mdi:magnify"></ha-icon>
      </button>
    `
      : "";

    const meta = [r.dirname, r.group_name, r.sizeMb ? `${Math.round(r.sizeMb)} ${r.sizeUnit || "MB"}` : "", fmtUnixSeconds(r.time)]
      .filter(Boolean)
      .join(" · ");

    return `
      <div class="qc-xrel-row">
        <div class="qc-xrel-main">
          <div class="qc-xrel-title" title="${esc(r.dirname)}">${esc(title)}</div>
          <div class="qc-rss-meta">${esc(meta)}</div>
        </div>
        <div class="qc-xrel-actions">
          ${searchBtn}
          ${actionHtml}
        </div>
      </div>
    `;
  }

  // ── Notifications: fetch ─────────────────────────────────────────────

  async _fetchUnreadCount() {
    try {
      const res = await this._callApi("GET", "notifications/unread-count");
      this._unreadCount = res?.count ?? 0;
    } catch (_) {
      // A background badge poll failing silently is preferable to an error
      // banner popping up every fast-poll tick if Questarr is briefly down.
      return;
    }
    this._render();
  }

  async _fetchNotifications() {
    try {
      const notifications = await this._callApi("GET", `notifications${qs({ limit: 50 })}`);
      this._notifications = Array.isArray(notifications) ? notifications : [];
    } catch (err) {
      this._setError(err, "Could not load notifications");
      return;
    }
    this._render();
  }

  // ── Notifications: actions ───────────────────────────────────────────

  _onAction_closeNotifications() {
    this._notifDropdownOpen = false;
    this._render();
  }

  async _onAction_markNotificationRead(el) {
    const { id } = el.dataset;
    try {
      await this._callApi("PUT", `notifications/${id}/read`);
      await Promise.all([this._fetchNotifications(), this._fetchUnreadCount()]);
    } catch (err) {
      this._setError(err, "Could not mark notification as read");
    }
  }

  async _onAction_markAllRead() {
    try {
      await this._callApi("PUT", "notifications/read-all");
      await Promise.all([this._fetchNotifications(), this._fetchUnreadCount()]);
    } catch (err) {
      this._setError(err, "Could not mark all notifications as read");
    }
  }

  async _onAction_clearReadNotifications() {
    try {
      await this._callApi("DELETE", "notifications");
      await this._fetchNotifications();
    } catch (err) {
      this._setError(err, "Could not clear notifications");
    }
  }

  // ── Notifications: render ────────────────────────────────────────────

  _renderNotificationsDropdown() {
    const rows = this._notifications.length
      ? this._notifications
          .map(
            (n) => `
        <div class="qc-notif-row ${n.read ? "" : "unread"}">
          <div class="qc-notif-body">
            <div class="qc-notif-title">${esc(n.title)}</div>
            <div class="qc-notif-message">${esc(n.message)}</div>
            <div class="qc-rss-meta">${fmtDate(n.createdAt)}</div>
          </div>
          ${
            n.read
              ? ""
              : `<button class="qc-btn icon secondary" data-action="markNotificationRead" data-id="${esc(n.id)}" title="Mark as read"><ha-icon icon="mdi:check"></ha-icon></button>`
          }
        </div>
      `
          )
          .join("")
      : `<div class="qc-empty">No notifications.</div>`;

    return `
      <div class="qc-modal qc-modal-narrow">
        <div class="qc-modal-scroll">
          <div class="qc-modal-header">
            <div class="qc-modal-title">Notifications</div>
            <button class="qc-btn icon secondary" data-action="closeNotifications"><ha-icon icon="mdi:close"></ha-icon></button>
          </div>
          <div class="qc-toolbar">
            <button class="qc-btn secondary" data-action="markAllRead">Mark all read</button>
            <button class="qc-btn secondary" data-action="clearReadNotifications">Clear read</button>
          </div>
          <div class="qc-notif-list">${rows}</div>
        </div>
      </div>
    `;
  }

  // ── Upcoming calendar: render only — derived from _games, which the
  // normal poll tier already refreshes via _fetchStats(), so this tab needs
  // no dedicated fetch of its own. ───────────────────────────────────────

  _renderUpcomingCalendar() {
    if (!this._gamesLoaded) return `<div class="qc-loading">Loading…</div>`;

    const now = Date.now() - 86400000; // include "today" even with a slightly-past timestamp
    const upcoming = this._games
      .filter((g) => !g.hidden && g.status === "wanted" && g.releaseDate && new Date(g.releaseDate).getTime() >= now)
      .sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));

    if (!upcoming.length) return `<div class="qc-empty">No upcoming releases among your wanted games.</div>`;

    return `
      <div class="qc-calendar-list">
        ${upcoming
          .map(
            (g) => `
          <button class="qc-calendar-row" data-action="openGame" data-id="${esc(g.id)}">
            <div class="qc-calendar-date">${fmtDate(g.releaseDate)}</div>
            <div class="qc-calendar-title">${esc(g.title)}</div>
            <span class="qc-badge ${esc(g.status)}">${STATUS_LABELS[g.status] || esc(g.status)}</span>
          </button>
        `
          )
          .join("")}
      </div>
    `;
  }

  // === PANEL METHODS INSERTION POINT — do not remove this comment ===
}

// ─────────────────────────────────────────────────────────────────────────
// Visual config editor
// ─────────────────────────────────────────────────────────────────────────

const EDITOR_SCHEMA = [
  { name: "title", selector: { text: {} } },
  {
    name: "panels_group",
    type: "grid",
    schema: [
      { name: "show_stats_header", selector: { boolean: {} } },
      { name: "show_notifications_bell", selector: { boolean: {} } },
      { name: "show_library", selector: { boolean: {} } },
      { name: "show_discover", selector: { boolean: {} } },
      { name: "show_downloads", selector: { boolean: {} } },
      { name: "show_indexer_search", selector: { boolean: {} } },
      { name: "show_rss", selector: { boolean: {} } },
      { name: "show_xrel", selector: { boolean: {} } },
      { name: "show_upcoming_calendar", selector: { boolean: {} } },
    ],
  },
  {
    name: "widgets_group",
    type: "grid",
    schema: [
      { name: "show_nexusmods_widget", selector: { boolean: {} } },
      { name: "show_pcgamingwiki_widget", selector: { boolean: {} } },
      { name: "show_hltb_widget", selector: { boolean: {} } },
    ],
  },
  {
    name: "tuning_group",
    type: "grid",
    schema: [
      { name: "library_page_size", selector: { number: { mode: "box", min: 6, max: 200, step: 1 } } },
      { name: "poll_interval", selector: { number: { mode: "box", min: 5, max: 300, step: 5 } } },
      { name: "fast_poll_interval", selector: { number: { mode: "box", min: 2, max: 60, step: 1 } } },
      {
        name: "default_tab",
        selector: { select: { mode: "dropdown", options: PANELS.map((p) => ({ value: p.key, label: p.label })) } },
      },
    ],
  },
];

const EDITOR_LABELS = {
  title: "Title",
  show_stats_header: "Show stats header",
  show_notifications_bell: "Show notifications bell",
  show_library: "Show library panel",
  show_discover: "Show discover panel",
  show_downloads: "Show downloads panel",
  show_indexer_search: "Show indexer search panel",
  show_rss: "Show RSS panel",
  show_xrel: "Show xREL panel",
  show_upcoming_calendar: "Show upcoming calendar",
  show_nexusmods_widget: "Show NexusMods widget on game details",
  show_pcgamingwiki_widget: "Show PCGamingWiki link on game details",
  show_hltb_widget: "Show HowLongToBeat widget on game details",
  library_page_size: "Library page size",
  poll_interval: "Poll interval (seconds)",
  fast_poll_interval: "Fast poll interval (seconds — downloads & notifications)",
  default_tab: "Default tab",
};

class QuestarrCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    this._render();
  }

  _render() {
    if (!this._config) return;
    if (!this._form) {
      // <ha-form> is a globally registered element in the Lovelace runtime —
      // no import needed, same approach the reference card's editor uses.
      this._form = document.createElement("ha-form");
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config } }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = this._config;
    this._form.schema = EDITOR_SCHEMA;
    this._form.computeLabel = (schemaItem) => EDITOR_LABELS[schemaItem.name] || schemaItem.name;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────

customElements.define(CARD_TAG, QuestarrCard);
customElements.define(EDITOR_TAG, QuestarrCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Questarr Card",
  description: "Monitor and manage your Questarr game library from Home Assistant.",
  preview: false,
  documentationURL: "https://github.com/hypersonic30/ha-questarr-card",
});

console.info(
  `%c QUESTARR-CARD %c v${CARD_VERSION} `,
  "color: white; background: #6b3fa0; font-weight: 700;",
  "color: #6b3fa0; background: white; font-weight: 700;"
); // eslint-disable-line no-console
