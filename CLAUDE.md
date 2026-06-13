# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

PickMe is a mobile-first PWA for multi-touch finger selection on a shared phone screen. Two modes:
- **F mode** — randomly selects N individual fingers after a 3-second countdown
- **G mode** — distributes all fingers into N evenly sized random groups, colored by group

## Commands

```bash
npm install        # install dependencies
npm run dev        # start Vite dev server (HMR)
npm run build      # production build → dist/
npm run preview    # serve production build locally
```

There is no test runner configured. Multi-touch behavior must be tested on a real mobile device — desktop browsers and emulators do not reliably simulate multiple simultaneous touch points.

## Architecture

The entire application is a single React component (`App`) in `src/main.jsx` (~400 lines). There are no sub-components, no routing, and no state management library. All logic lives in one file.

### Pointer event flow

All touch/mouse input enters through three handlers on the root `<main>` element: `handlePointerDown`, `handlePointerMove`, `handlePointerEnd`. The Pointer Events API (not Touch Events) is used throughout.

Each active touch is stored as an entry in the `fingers` state array with `{ id, x, y, kind, label }`. `kind` is either `'pick'` (a counting finger) or `'control'` (a UI interaction that should not be counted).

The top-left corner (`isTopLeft`) is the control dot — dragging it adjusts `winnerCount` (drag down) or toggles mode (drag right). The top-right corner (`isTopRight`) opens help. All other touches are `'pick'` fingers.

### Countdown and selection

- When 2+ `'pick'` fingers are active and no `selection` exists, `roundStartedAt` is set.
- A `setTimeout` fires after the remaining milliseconds of `ROUND_MS` (3000 ms).
- At timeout: in F mode, `randomPick()` (Fisher-Yates) selects winners; in G mode, `createGroups()` distributes fingers round-robin across N groups.
- `selection` is set to `{ type: 'finger'|'group', ... }`, which renders the result overlay.
- Touching the screen while a result is shown calls `resetRound()`, clearing everything.

### Animation

`requestAnimationFrame` runs on every tick updating `now` (a timestamp). `progress` is derived as `(now - roundStartedAt) / ROUND_MS` clamped to [0, 1]. The CSS animation duration for finger rings is `pulseDuration = 1.8 - progress * 1.35` seconds — so the pulse accelerates as the countdown nears completion. CSS variables (`--ring-color`, `--ring-glow`, `--ring-fill`) are set inline per finger to drive ring color without JS-driven style updates.

### Control dot drag mechanics

When a pointer down hits the top-left zone, the control dot enters an "adjusting" state tracked via `controlPointerId` ref. Drag distance is measured from the drag start point:
- Downward distance → `winnerCount` increments by 1 per `NUMBER_STEP_DISTANCE` (78 px)
- Rightward distance beyond `MODE_TOGGLE_DISTANCE` (84 px) → toggles mode; `MODE_TOGGLE_HYSTERESIS` (22 px) prevents oscillation
- The dot visually offsets via `controlOffset` state, capped at 96 px horizontal, 220 px vertical

### Selection bounds

- F mode: 1–10 fingers
- G mode: 2–5 groups

`clampSelectionCount` enforces these bounds. `winnerCount` is reset to the current mode's minimum whenever a new control drag begins.

## Key Constants (src/main.jsx)

| Constant | Value | Purpose |
|---|---|---|
| `ROUND_MS` | 3000 | Countdown duration in ms |
| `CONTROL_SIZE` | 96 | Corner hit zone in px |
| `NUMBER_STEP_DISTANCE` | 78 | px per count increment during drag |
| `MODE_TOGGLE_DISTANCE` | 84 | px rightward drag to toggle mode |
| `MODE_TOGGLE_HYSTERESIS` | 22 | px deadband to prevent mode flickering |

## PWA / Service Worker

`public/sw.js` uses a cache-first strategy (cache name `pickme-v2`). When modifying cached assets, bump the cache version in `sw.js` to force clients to update. The service worker is registered in a `useEffect` on mount.

## Deployment

Deployed to Vercel. `vercel.json` specifies `npm run build` and `dist/` as output. Vercel Analytics is imported from `@vercel/analytics/react` and rendered alongside `<App />` in the root render call.
