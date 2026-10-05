# To-do

Air Dots. Nothing here is started. Do them in order. Each one lands on Friday, not in a side app.

## 1. The worker

- [ ] An Air Dot job on the Friday runtime: a graph, a loop, the same shape of work as Build Mode
- [ ] It runs in the existing per-user E2B sandbox
- [ ] It keeps going until the task is done
- [ ] "rukho" or "stop" pauses it
- [ ] An empty Friday usage meter stops it and keeps the work
- [ ] Idle machines pause. Start the idle limit at 8 minutes
- [ ] A daily awake cap so a loop cannot hold a machine open
- [ ] Browser, shell, and files go through one gate that records the action
- [ ] Pay, send, and delete wait for a yes

## 2. The website

- [ ] Call now on the Friday site, on the On Air surface
- [ ] The button is hidden unless the plan is Pro or Premium
- [ ] Starting a Dot from chat spends only the Friday meter

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
- [ ] Spoken passphrase, hashed, asked before pay, send, or delete
- [ ] They can set or change the passphrase by talking

## 5. After the job

- [ ] Friday calls back when the Dot is done, if they asked or if that is their setting
- [ ] The result is also in the Friday thread
- [ ] Call memory: transcript, capped recap, open loops, on the account

## Not in this build

- [ ] A new mobile app
- [ ] A plugin per website
- [ ] A personal SIM as the public number
- [ ] Grok audio, until admin flips the voice provider
