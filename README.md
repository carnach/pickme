# PickMe

PickMe is a small mobile-first PWA for choosing one or more people from a shared phone screen. Everyone places a finger on the screen, the app counts down, and PickMe either selects fingers or splits everyone into groups.

It is designed for quick, informal decisions: who goes first, who is on which team, who gets picked, or how to split a group evenly.

## Features

- Multi-touch finger detection
- Pulsing circles around active fingers
- Three-second countdown once two or more fingers are touching
- Countdown speed increases as the choice gets closer
- Adding another finger resets the countdown
- `F` mode selects one or more individual fingers
- `G` mode splits all fingers into random, evenly sized groups
- Top-left control dot for changing the number and mode
- Top-right help dot
- PWA manifest and service worker for installable/offline use
- Vercel-ready Vite build setup

## How It Works

PickMe has two modes:

- `F` means finger selection. After the countdown, only the randomly selected finger circles remain on screen.
- `G` means group selection. During the countdown, all circles are white. At the end, every finger is assigned to a group and the circles are colored by group.

The green or blue control dot in the top-left controls the current selection:

- Press it to reset the number to the current mode minimum.
- Drag it downward to increase the number.
- Drag it to the right to toggle between `F` and `G`.
- Release it and the dot snaps back into place.

The dot is green in `F` mode and blue in `G` mode. `F` mode supports selecting 1 to 10 fingers, and `G` mode supports 2 to 5 groups. The orange dot in the top-right opens the help screen.

## Selection Logic

PickMe uses browser Pointer Events to track active touches. Each finger gets:

- a pointer ID
- a screen position
- a visible number
- a color in `F` mode

When at least two fingers are touching the screen, a three-second timer starts. The pulse animation accelerates over that period. If another finger is added, the timer resets so everyone gets a fair chance to join.

In `F` mode, PickMe shuffles the active fingers and chooses the configured number of winners. If the requested number is greater than the available fingers, all fingers are selected.

In `G` mode, PickMe shuffles the active fingers and distributes them across the configured number of groups in round-robin order. Group selection is limited to 2 to 5 groups so each group can have at least two fingers when 10 fingers are active. This keeps group sizes as even as possible while still being random.

## Touch Limitations

PickMe supports selecting up to 10 fingers, but the real limit depends on the phone and browser. Many devices support around 5 to 10 simultaneous touch points.

## Technology Stack

- React
- Vite
- Plain CSS
- Pointer Events
- Web App Manifest
- Service Worker
- Vercel static deployment

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Build for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Deploying to Vercel

The project includes `vercel.json`, so Vercel can build it with:

```bash
npm run build
```

The production output directory is:

```bash
dist
```

To link and deploy with the Vercel CLI:

```bash
vercel link
vercel --prod
```

## Notes

Multi-touch behavior is best tested on a real mobile device. Desktop browsers and device emulators may not accurately simulate multiple simultaneous fingers.
