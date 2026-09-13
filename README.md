# Todo Reminder

A simple, dependency-free todo app with due-time reminders. Built with vanilla JS + Vite, styled with the acasa color palette.

![CI](https://github.com/WSS5480/TODO-APP/actions/workflows/test.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

Live: https://todo-app-qpd5.onrender.com

## Features
- Add / complete / delete tasks
- **Edit a task** in place — change its title, due time or priority (Escape or Cancel backs out)
- Optional due date & time with priority (low / med / high)
- **Eight alarm sounds** — Chime, Bell, Ping, Urgent, Marimba, Digital, Klaxon and Soft, all synthesized in-app (no audio files)
- **Tap a sound to hear it** — the picker is a row of chips, so you audition sounds with one tap instead of opening a dropdown; per-task alarms preview as you pick them too
- **The heads-up and the real alarm sound different**, so an early warning is never mistaken for a task actually being due
- **Per-task alarms** — give an important task its own sound when you add or edit it; it shows as a ♪ pill on the row
- **Repeat** a due alarm once, 3×, 5×, or until you hit Snooze or Done
- **Heads-up alert** a configurable 5–60 minutes before the due time
- **Snooze 10 min / Done** buttons right on the alert
- Desktop notifications (where the browser supports them) that stay up until dismissed
- Tab title shows the overdue count so you notice it from another tab
- Overdue tasks highlighted, due-soon tasks flagged
- Saves to `localStorage` (survives refresh & close)

Alarms fire while the tab is open — there is no server, so nothing runs when the tab is closed. On a phone, keep it open in the foreground for alarms.

## Install on your phone

The app ships a web manifest and icons, so it can be installed to a Home Screen and opens standalone, without browser chrome.

**iPhone / iPad (Safari):** open the site in **Safari** (not Chrome — only Safari can install to the Home Screen on iOS), tap the **Share** button, then **Add to Home Screen**.

**Android (Chrome):** tap the **⋮** menu, then **Install app** / **Add to Home screen**.

Two things to know on iOS:

- **Alarms still only ring while the app is open and in the foreground.** Installing it does not buy background execution — iOS suspends timers as soon as you switch apps or lock the screen. Nothing here runs on a server, so a closed app rings nothing.
- **The installed app has its own storage.** iOS gives a Home Screen app a separate storage area from Safari, so tasks you added in Safari will not appear in the installed copy. Start fresh there.

## Quick start
```bash
git clone https://github.com/WSS5480/TODO-APP.git
cd TODO-APP
npm install
npm run dev
```

## Scripts
| Command | What it does |
| --- | --- |
| `npm run dev` | Local dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the unit tests (Vitest) |

## Deploy
Deployed on Render as a static site: build command `npm install && npm run build`, publish directory `dist`. Every push to `main` redeploys automatically.
