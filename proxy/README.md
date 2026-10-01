# The companion service

Two jobs, one Worker: reading your calendar, and ringing your alarms when the
app is closed.

## Calendar reader

A published iCloud calendar is a public `.ics` file at a `webcal://` address.
The app cannot read it directly: iCloud sends no CORS headers, so the browser
fetches the file and then refuses to hand the page a single byte of it. That is
not something the page can work around — the header has to come from the server
serving the file, and that server belongs to Apple.

This is the smallest thing that fixes it. One endpoint fetches the calendar and
returns it with permission to read it. No database, no credentials, nothing
stored beyond a five-minute in-memory cache.

```
GET /ics?url=webcal://p1-calendars.icloud.com/published/2/...
GET /healthz
```

## Why it has a guest list

A service that fetches any URL a caller names is an open proxy, and an open
proxy inside a hosting provider's network is worth something to somebody: point
it at `169.254.169.254` and it reads the provider's own instance metadata, or at
anything else running in the same private network. So:

- `https` only (`webcal://` is accepted and rewritten, since that is the form
  Calendar hands you)
- the host must be a known calendar service — a suffix match anchored so that
  `icloud.com.evil.test` cannot pass as iCloud
- the host must resolve only to public addresses, re-checked on every redirect
- 5 MB ceiling, 20-second timeout, 4 redirects, 30 requests per minute per IP
- the response must actually look like a calendar

`proxy/validate.test.mjs` and `proxy/server.test.mjs` cover all of it, including
the cases that must be refused before a socket is opened.

## Running it

```
node server.mjs          # listens on $PORT, default 10000
npx vitest run proxy/    # the tests
```

| Variable          | Default | What it does |
| ----------------- | ------- | ------------ |
| `PORT`            | `10000` | Port to listen on. |
| `ALLOWED_ORIGINS` | `*`     | Comma-separated origins allowed to read the response. Worth setting to the app's own URL. |
| `EXTRA_HOSTS`     | —       | Extra calendar hosts, comma-separated, for a provider not already on the list. |
| `CACHE_SECONDS`   | `300`   | How long an answer is reused. |
| `RATE_MAX`        | `30`    | Requests per minute per IP. |

`*` is a safe default here, not an oversight: the response is a public calendar
and the service holds no cookies or credentials, so there is nothing for another
site to gain by reading it. Narrowing it to the app's own origin is still worth
doing, to keep the service to its own job.

## Push alarms

The app's own alarms stop the moment you leave it: iOS suspends the page and
its timers with it. Nothing in a web page can survive that. What can is a push
— sent from here, delivered by Apple, and shown by the app's service worker.

So this service is also a clock. It holds, per device, a push subscription and
a list of `{ title, time }`. Once a minute the cron trigger asks what has come
due and posts it. It knows nothing about tasks, recurrence or completion: the
app works all that out and re-uploads the list whenever anything changes, and
the list is replaced wholesale, so a task deleted on the phone stops ringing.

```
GET  /push/key          the VAPID public key, so the app needs no configuration
POST /push/subscribe    { subscription, label, alarms }
POST /push/alarms       { endpoint, alarms }   replaces that device's schedule
POST /push/unsubscribe  { endpoint }
POST /push/test         { endpoint }           sends one straight away
```

Two details that are easy to get wrong and silent when you do. The VAPID JWT's
audience is the push endpoint's **origin**, not the whole URL — the usual cause
of a 401. And in the message encryption the two public keys go into the key
info receiver-then-sender; swapping them yields perfectly valid ciphertext that
the phone cannot decrypt, with no error anywhere. `push.test.mjs` decrypts what
`push.mjs` produces, written from the spec rather than from the code, so both
of those are caught here rather than by a notification that never arrives.

An alarm more than ten minutes late is retired instead of sent. A reminder that
goes off hours after the fact is worse than none — it rings about something
already passed, when nobody knows why their phone is buzzing.

### Setting it up

Once, from this folder:

```bash
npx wrangler d1 create todo-push          # paste the database_id into wrangler.toml
npx wrangler d1 execute todo-push --remote --file=./schema.sql
node vapid-keygen.mjs mailto:you@example.com   # prints three secret commands; run them
npx wrangler deploy
```

The keypair is long-lived on purpose: a subscription is bound to the key it was
created with, so rotating the keys silently breaks every device already
subscribed. The private key belongs only in `wrangler secret` — never in the
repo, never in a chat window.

Then in the app: gear → **Alarms when the app is closed** → turn it on, and
**Send a test**. On iOS the app must be on your Home Screen first; in a Safari
tab the APIs exist and subscribing fails.

## On Render

A web service, root directory `proxy`, build `npm install`, start `npm start`.
On the free plan it sleeps when idle, so the first pull after a quiet spell
takes a few seconds longer — the app's own timeout allows for that.

The Node version serves the calendar only. Push needs the database and the
minute-by-minute cron, which is why it lives on the Worker.
