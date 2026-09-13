# Todo Reminder

A simple, dependency-free todo app with due-time reminders. Built with vanilla JS + Vite, styled with the acasa color palette.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

Live: https://todo-app-qpd5.onrender.com

## Features
- Add / complete / delete tasks
- Optional due date & time with priority (low / med / high)
- **Alarm chime** when a task comes due (synthesized in-app, no audio files; toggle with the Sound button)
- **Heads-up alert** a configurable 5–60 minutes before the due time
- **Snooze 10 min / Done** buttons right on the alert
- Desktop notifications (where the browser supports them) that stay up until dismissed
- Tab title shows the overdue count so you notice it from another tab
- Overdue tasks highlighted, due-soon tasks flagged
- Saves to `localStorage` (survives refresh & close)

Alarms fire while the tab is open — there is no server, so nothing runs when the tab is closed. On a phone, keep it open in the foreground (or add it to the home screen) for alarms.

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
