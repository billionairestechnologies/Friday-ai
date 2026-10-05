# To-do

Air Dots lives on the `v3` branch of Friday. The website door is in. The phone trunks are not.

## 1. The worker

- [x] An Air Dot job on the Friday runtime: same chat and Build Mode, tagged `origin: air`
- [x] A clear "build me an app" ask opens the existing E2B sandbox
- [x] "Stay on it" keeps going for a few turns until the reply says it is done or blocked
- [x] "rukho" or "stop" pauses it
- [x] An empty Friday usage meter stops it (the existing quota gate)
- [ ] Idle machines pause at 8 minutes, and a daily awake cap
- [ ] Browser, shell, and files go through one recorded gate
- [x] Pay and delete wait for the passphrase once it is set

## 2. The website

- [x] Call now on `/air` (browser line; the phone trunk is still open)
- [x] Air Dots is hidden unless the plan includes it
- [x] Starting a Dot spends the Friday meter and shows up as Air Dots
- [x] Friday's face is the clover bot from bot-avatars, with thinking-orbs while a reply is working and a border beam on the composer
- [x] States used now: idle, listening, working

## 3. Outbound call

- [ ] Pipecat session to Gemini Live
- [ ] Context compression on, so a long call does not re-bill the whole audio history
- [ ] Exotel places the call to the verified mobile
- [ ] Pro: 15 minutes a month. Premium: 60. Separate from the usage meter
- [ ] Short work stays on the line. Long work hangs up and the Dot continues
- [ ] Persona prompt: short, one question, one curious beat, then wait

## 4. Inbound call

- [ ] One public number. Exotel for India, Telnyx or Twilio for everywhere else
- [ ] Caller ID matches the account or the call ends
- [x] Spoken passphrase, hashed, asked before pay or delete once it is set
- [ ] They can set or change the passphrase by talking

## 5. After the job

- [ ] Friday calls back when the Dot is done, if they asked or if that is their setting
- [ ] The result is also in the Friday thread
- [ ] One memory per user, shared by the website, the Air Dot, and the phone
- [ ] Save every call transcript and every Dot job. Do not trim the store
- [ ] A new call and a new Dot run both load that user's memory before the first reply

## Not in this build

- [ ] A new mobile app
- [ ] A plugin per website
- [ ] A personal SIM as the public number
- [ ] Grok audio, until admin flips the voice provider
