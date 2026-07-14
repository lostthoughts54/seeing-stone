# Adam and Kayla SyncPlay test run

Use this sheet with the exact installer below. Check each item only after observing it on both computers.

## Test build

```text
D:\docs\jellyfin player\.runtime\release\LocalFirst-Jellyfin-Setup-0.4.0-x64.exe
SHA-256: b132f100258f32167a9038a5520bee5b0554c8c329c29f8ef5653612132008f2
Jellyfin server: 10.11.11 only
```

Windows may show an unknown-publisher warning because this private test installer is not Authenticode-signed.

## Before starting

- [ ] Adam and Kayla each have a distinct Jellyfin account with SyncPlay access.
- [ ] Both accounts can play the chosen episode and its cross-season Next Up episode.
- [ ] The client is installed and signed in on both Windows computers.
- [ ] Kayla downloaded the chosen first episode inside this client and it says `Downloaded` in Downloads.
- [ ] Adam did not download that episode inside his client.
- [ ] Both clients show the same Jellyfin server name and version `10.11.11`.

Chosen show: ______________________________

First episode: _____________________________

Expected cross-season Next Up episode: _____________________________

## Run

### 1. Discovery and joining

- [ ] With Kayla signed out, Active Watch Parties cannot be opened or enumerated.
- [ ] After both sign in, both open Active Watch Parties.
- [ ] Adam creates a clearly named party.
- [ ] Without pressing Refresh, the party appears on Kayla's computer within about five seconds.
- [ ] Kayla joins it.
- [ ] Both joined-party cards list Adam and Kayla and say controls are shared.

Party name: ________________________________

### 2. Exact item and local-first delivery

- [ ] Either participant opens the chosen first episode and presses Play.
- [ ] Both native player windows open the same episode.
- [ ] Kayla's joined-party card says `This computer: Local download`.
- [ ] Adam's joined-party card says `This computer: Jellyfin stream`.
- [ ] Audio and video play normally on both computers.

### 3. Shared controls

- [ ] Adam pauses; both computers pause once.
- [ ] Adam resumes; both computers resume without bouncing between states.
- [ ] Adam seeks forward at least two minutes; both computers converge near the same position.
- [ ] Kayla pauses; both computers pause once.
- [ ] Kayla resumes; both computers resume without bouncing between states.
- [ ] Kayla seeks to a different position; both computers converge near the same position.
- [ ] Small timing differences settle without constant seeking or speed oscillation.

### 4. Buffering and reconnect

- [ ] Temporarily interrupt only Kayla's client network connection while the Jellyfin server stays reachable from Adam.
- [ ] Adam's client remains usable and the party shows a waiting or reconnecting state rather than silently diverging.
- [ ] Restore Kayla's network within 15 seconds.
- [ ] Kayla automatically reconnects to the same party, or receives the documented actionable failure if the server removed it.
- [ ] After recovery, one pause and one seek converge on both computers.
- [ ] If either player remains visibly out of position, press `Resync This Computer` on that client and confirm only that player jumps back into alignment.

### 5. Cross-season Next Up

- [ ] Replay or seek near the end of the selected season finale.
- [ ] Let the episode complete naturally; do not manually choose the next episode.
- [ ] Only one Next Up countdown drives the group transition.
- [ ] Both computers open the same exact first episode of the next season.
- [ ] Kayla again reports Local download only if that exact next episode was downloaded; otherwise she reports Jellyfin stream.
- [ ] Shared pause and seek still work after the transition.

### 6. Leaving and cleanup

- [ ] Kayla leaves the party and can control her playback independently.
- [ ] Adam leaves the party and can control his playback independently.
- [ ] The empty party disappears from both Active Watch Parties lists.
- [ ] Solo Next Up behavior works normally after leaving.
- [ ] Signing out clears the joined-party state.

## Result

Date and time: ______________________________

Adam computer / Windows version: ______________________________

Kayla computer / Windows version: ______________________________

- [ ] PASS — every required item above passed.
- [ ] FAIL — one or more items failed; record the first failure below.

First failed step: ______________________________

What each screen said: ______________________________

Approximate playback positions on both computers: ______________________________

Did either player close or show an error? ______________________________

Screenshots or notes: ______________________________

Do not uninstall either copy after a failure until the failure details have been recorded.
