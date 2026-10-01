// Make the one keypair that identifies this app to the push services.
//
//   node vapid-keygen.mjs
//
// Run it once. The pair is long-lived on purpose: a push subscription is bound
// to the public key it was created with, so changing the keys silently breaks
// every device already subscribed — they keep their subscriptions, the pushes
// are rejected, and nothing says why. If you ever do rotate them, everyone has
// to turn notifications off and on again.
//
// The private key is a credential. It never belongs in the repository, in a
// chat window, or in wrangler.toml — only in `wrangler secret`, which is what
// the commands below use.

import { writeFileSync } from "node:fs";
import { generateVapidKeys } from "./push.mjs";

const { publicKey, privateKey } = await generateVapidKeys();

const subject = process.argv[2] || "mailto:you@example.com";

// Each value also goes to its own file, and a script feeds those files to
// wrangler with `<`. Typing or pasting a 43-character key three times into a
// prompt is where this goes wrong, and a key with one stray character fails
// silently — the only symptom is a notification that never arrives.
//
// The files hold a credential, so the script deletes them the moment the
// secrets are stored, and .gitignore keeps them out of the repository.
writeFileSync(".vapid-private.txt", privateKey);
writeFileSync(".vapid-public.txt", publicKey);
writeFileSync(".vapid-subject.txt", subject);

writeFileSync(
  "set-secrets.bat",
  [
    "@echo off",
    "cd /d \"%~dp0\"",
    "echo Storing the three secrets with Cloudflare ...",
    "echo.",
    "call npx wrangler secret put VAPID_PRIVATE_KEY < .vapid-private.txt || goto :failed",
    "call npx wrangler secret put VAPID_PUBLIC_KEY < .vapid-public.txt || goto :failed",
    "call npx wrangler secret put VAPID_SUBJECT < .vapid-subject.txt || goto :failed",
    "del /q .vapid-private.txt .vapid-public.txt .vapid-subject.txt >nul 2>&1",
    "echo.",
    "echo Done. The key files have been deleted.",
    "echo Check with:  npx wrangler secret list",
    "pause",
    "exit /b 0",
    ":failed",
    "echo.",
    "echo Something went wrong - the key files have been left in place so you",
    "echo can run this again. Delete them yourself if you give up on it.",
    "pause",
    "exit /b 1",
    "",
  ].join("\r\n"),
);

// Printed as command-then-value rather than piped from `echo`, because
// Command Prompt echoes the quotes and a trailing space along with the value.
// A key stored with a stray quote fails to decode, and the only symptom is a
// notification that never arrives.
console.log(`
A new VAPID keypair, written to three files in this folder.

Now run this, which stores all three with Cloudflare and then deletes the
files:

    set-secrets.bat

Nothing to copy or paste. When it finishes, check with:

    npx wrangler secret list

Contact address for the push services: ${subject}
`);

if (!process.argv[2]) {
  console.log(`Pass your email to set the contact address the push services ask for:

  node vapid-keygen.mjs mailto:you@example.com
`);
}

console.log(`The app fetches the public key from the Worker at /push/key, so there is
nothing to paste into the app itself. Keep the private key out of the repo;
if it leaks, anyone could send notifications to your devices.
`);
