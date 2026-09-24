# TODO

Things this project still owes its users, in the order they hurt.

---

## MUST: pace long jobs so the machine can cool down

**The problem.** The tube in this Helix is old. After roughly five minutes of
continuous cutting or engraving its power drops — you can hear the fans go up —
and the back half of a long job comes out weaker than the front. The workaround
today is entirely manual: split the artwork by hand, send one part, wait about
five minutes, send the next.

**What the machine will and won't do.** The job we send is PJL → PCL → HP-GL:
raster rows (`ESC*b…W`), and vectors as `XR` frequency, `YP` power, `ZS` speed,
`PU`/`PD` moves (see `driver/epilog.py`). **There is no wait / dwell / sleep
command in that dialect**, and the Helix will not start a job on its own — GO is
a hardware press, by design. So a job cannot carry "…then rest for five minutes"
in the ordinary way, and pacing has to come from us.

### Plan

**A. Estimate the run time.** Everything below needs it. We already hold every
path in mm plus speed / power / DPI: vector time ≈ path length ÷ (speed % × the
machine's top ips), raster time ≈ rows × swept width ÷ speed, plus a per-move
acceleration penalty. Calibrate the constants against three stopwatched jobs —
the app can ask "how long did that take?" once and keep the answer in
`config.json`. Show the estimate next to **Send**.

**B. Sections.** Split the placed pages into sections, either automatically
("keep each section under N minutes", default 5) or by hand. **Send** sends
section 1 only; the card then becomes a queue — "section 1 of 4 sent · press
GO", a cool-down countdown, then "send section 2" lights up with a sound. Each
section is an ordinary job, so the driver and every safety guard stay as they
are. This removes the re-layout and re-send work; the operator still presses GO
per section. **Biggest win for the least risk — do this first.**

**C. Start the clock from the machine, not from a guess.** Find out whether the
Helix answers the RFC 1179 queue-state request (`\x03<queue>\n` on port 515)
with anything that tells busy from idle. `driver/laserlink.py` only opens the
port today. If it answers, the cool-down starts when the cut really ends and the
next section can go out by itself; if it doesn't, fall back to A's estimate plus
an "it's finished" button.

**D. Dwell inside one job (experimental).** Between sections, insert a part made
*only* of `PU` moves — pen-up travel is beam-off by the protocol's own
semantics, unlike trusting `YP000` — parking the head in a corner and crawling
it for the rest period. The job stays alive, the exhaust keeps running, the tube
rests, and a long job needs **one** GO press. Prove it on scrap before trusting
it: does the Helix actually spend wall-clock time on PU-only paths or optimise
them away, is the beam definitely off, does anything time out? Opt-in behind a
setting if it survives that.

### Notes

* A cool-down schedule paces the heat, it does not fix a tired tube. If power
  has dropped for good, the same section cut twice at lower power may finish
  cooler than one hot pass — worth testing while measuring for A.
* Never unattended, whatever we automate: the lid stays closed, the extraction
  stays on, and someone stays in the room.
