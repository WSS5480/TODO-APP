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

import { generateVapidKeys } from "./push.mjs";

const { publicKey, privateKey } = await generateVapidKeys();

const subject = process.argv[2] || "mailto:you@example.com";

console.log(`
A new VAPID keypair. Run these three commands from this folder:

  echo "${privateKey}" | npx wrangler secret put VAPID_PRIVATE_KEY
  echo "${publicKey}" | npx wrangler secret put VAPID_PUBLIC_KEY
  echo "${subject}" | npx wrangler secret put VAPID_SUBJECT
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
