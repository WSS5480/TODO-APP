# To Do Reminder

A simple, dependency-free todo app with due-time reminders. Built with vanilla JS + Vite, styled with the acasa color palette.

![CI](https://github.com/WSS5480/TODO-APP/actions/workflows/test.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

Live: https://todo-app-qpd5.onrender.com

## Features
- Add / complete / delete tasks
- **Edit a task** in place — change its title, due time, priority or repeat (Escape or Cancel backs out)
- Optional due date & time with priority (low / med / high)
- **Repeating tasks** — daily, weekdays, weekly, monthly or yearly; ticking one off moves it to its next occurrence instead of closing it
- **Pull in your calendar** — a published iCloud (or Google, or Outlook) calendar becomes tasks, and keeps up with changes made there
- **Eight alarm sounds** — Chime, Bell, Ping, Urgent, Marimba, Digital, Klaxon and Soft, all synthesized in-app (no audio files)
- **Tap a sound to hear it** — the sound samples live behind the gear icon, as a row of chips you audition with one tap; per-task alarms preview as you pick them too
- **The heads-up and the real alarm sound different**, so an early warning is never mistaken for a task actually being due
- **Per-task alarms** — give an important task its own sound when you add or edit it; it shows as a ♪ pill on the row
- **Repeat** a due alarm once, 3×, 5×, or until you hit Snooze or Done
- **Heads-up alert** a configurable 5–60 minutes before the due time
- **Snooze 10 min / Done** buttons right on the alert
- Desktop notifications (where the browser supports them) that stay up until dismissed
- Tab title shows the overdue count so you notice it from another tab
- Overdue tasks highlighted, due-soon tasks flagged
- Saves to `localStorage` (survives refresh & close)

The app's own alarms fire while the tab is open; iOS suspends its timers the moment you leave it. For a reminder that rings with the app closed, export to the calendar — see below.

## Repeating tasks

Pick a repeat when you add a task, or in the edit form. The row then carries a **↻** pill, and hovering it says how the series ends.

Completing a repeating task does not close it: it moves to the next occurrence, re-arms both alarms and counts one off the series. Complete one three days late and it schedules the *next* one in the future rather than dropping you in the past.

Two details worth knowing, both chosen to match what a calendar does with the same event, so the app and an exported event never disagree:

- Dates advance by calendar fields, not by adding 24 hours, so a 9am task is still 9am after the clocks change.
- A monthly repeat on the 31st **skips** months that have no 31st, rather than sliding to the 28th. Same for February 29th on a yearly repeat.

## Pull from your calendar

A web page cannot read the iPhone calendar — iOS gives that to native apps only. What it can read is a **published** calendar, which is a plain `.ics` file at a `webcal://` address.

In Calendar on your iPhone: tap the **ⓘ** next to a calendar, turn on **Public Calendar**, copy the link, and paste it into **Pull from your calendar** in the settings panel. Then **Pull now**, or leave it to check by itself every hour while the app is open.

Events become tasks keyed on the calendar's own event id, so pulling twice updates them rather than piling up duplicates. A repeating event arrives as a repeating task. Past events are left behind; a repeating series that started in the past is rolled forward to its next occurrence. Move an event in Calendar and the next pull moves the task and re-arms its alarm. Tick **Remove tasks when the event is deleted** and a cancelled event takes its task with it — tasks you typed yourself are never touched either way.

You can also **Import a .ics file** or paste calendar text, which needs no network at all.

One wrinkle, and the reason there is a small service involved: iCloud sends no CORS headers with a published calendar, so the browser fetches the file and then refuses to let the page read it. That is not something the page can fix. A tiny reader service does the fetch instead — see [`proxy/`](proxy/), which runs as a free Cloudflare Worker or as a Node service.

## Calendar export

A web page cannot read or write the phone's calendar — iOS only exposes that to native apps — but it can hand over a standard `.ics` file, which Calendar offers to import.

- **📅 on any task with a due time** exports that one task
- **Export to calendar** in the settings panel exports every task that has a due time

Each event carries an alarm at the due time, plus a second one matching your heads-up setting. This is the one way to get a reminder that fires **while the app is closed**: iOS suspends the app's own timers as soon as you leave it, but a calendar alert still goes off.

A repeating task exports as **one repeating event** (`RRULE`), so a single export carries every future alarm rather than only the next one.

Export is one-way. Editing or deleting a task afterwards does not change an event already in your calendar. Events do keep a stable id per task, so re-exporting the same task updates it in place rather than adding a duplicate, in calendars that honour that.

## Updates

Installed to a Home Screen there is no reload button, and iOS can hold on to a cached copy of the page indefinitely — which otherwise means deleting and reinstalling the app to pick up a new version.

Every build stamps a version into the bundle and writes the same value to `version.json`. The running app checks that file on launch, whenever you switch back to it, and every 15 minutes. When the deployed build differs it shows **A new version is available**; tapping **Update now** reloads onto a URL the cache has never seen, so the stale page cannot be served again.

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
| `npm test` | Run the unit tests (Vitest) — app and proxy |
| `npm start` | Run the calendar reader service locally |

## Deploy

Deployed on Render as a static site: build command `npm install && npm run build`, publish directory `dist`.

Deploys are driven by GitHub Actions rather than Render's own auto-deploy, so a push only reaches the site after the tests pass. On a push to `main`, the `deploy` job POSTs to the service's Render **Deploy Hook**.

It needs one secret. Without it the job logs a warning and skips, so nothing breaks until it is set:

1. Render dashboard → **todo-app** → Settings → **Deploy Hook**, copy the URL
2. GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**
3. Name it `RENDER_DEPLOY_HOOK`, paste the URL

A `4xx` from Render fails the job immediately with a message pointing at the hook URL; a network blip or `5xx` is retried three times with backoff.

The calendar reader service deploys separately, from [`proxy/`](proxy/). A free Cloudflare Worker is the one to use — it does not sleep, so the first pull of the day is as quick as the rest:

```bash
cd proxy
npx wrangler deploy
```

Then paste the Worker's address, with `/ics` on the end, into **Reader service** in the settings panel. There is also a Render web service (`todo-cal-proxy`) running the Node version of the same thing, which works but sleeps when idle.
