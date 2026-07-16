# Adam and Kayla SyncPlay test run

Use this sheet with the exact installer below. Check each item only after observing it on both computers.

## Test build

```text
D:\docs\jellyfin player\.runtime\release\LocalFirst-Jellyfin-Setup-0.4.3-x64.exe
Bytes: 120490443
SHA-256: 4def44f554b6408093f956dc83f567cc7049763243a1019b6e174731ea2b6d5f
Jellyfin server: 10.11.11 only
```

Windows may show an unknown-publisher warning because this private test installer is not Authenticode-signed.

The earlier two-computer run on 0.4.2 successfully reached shared playback but left Kayla audibly 0.5-1.0 seconds behind. Version 0.4.3 is the current build because it replaces the overly broad timing tolerance with smooth tiered correction while keeping the automatic three-second seek boundary. Adam accepted release without delaying for a second physical run; this sheet remains available for later troubleshooting or regression testing.

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
- [ ] Leave the second participant outside the party briefly so the active-room join path can be tested below.

Party name: ________________________________

### 2. Exact item and local-first delivery

- [ ] Adam opens the chosen first episode and presses Play while he is the only participant in the party.
- [ ] Adam seeks at least one minute into the episode and confirms it is playing.
- [ ] The second participant joins the already-playing party.
- [ ] Both native player windows open the same episode.
- [ ] The joining player lands near Adam's current position and begins playing without requiring a separate Play press.
- [ ] Both joined-party cards list both participants and say controls are shared.
- [ ] LocalFirst Jellyfin remains present on the Windows taskbar while each native player is open.
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
- [ ] Keep both players audible for at least one minute. A small offset shrinks instead of remaining fixed, without visible video jumps or speed oscillation.
- [ ] Automatic correction does not seek for a difference under three seconds. The explicit `Ctrl+R` action may still jump because it is a user-requested immediate resync.

### 4. Buffering and reconnect

- [ ] Temporarily interrupt only Kayla's client network connection while the Jellyfin server stays reachable from Adam.
- [ ] Adam's client remains usable and the party shows a waiting or reconnecting state rather than silently diverging.
- [ ] Restore Kayla's network within 15 seconds.
- [ ] Kayla automatically reconnects to the same party, or receives the documented actionable failure if the server removed it.
- [ ] After recovery, one pause and one seek converge on both computers.
- [ ] If either player remains visibly out of position, press `Ctrl+R` inside that player and confirm only that computer jumps back into alignment and shows a resync confirmation.
- [ ] Restore LocalFirst Jellyfin from the taskbar, press `Resync This Computer`, and confirm the same local-only correction remains accessible during playback.

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

- [ ] PASS - every required item above passed.
- [ ] FAIL - one or more items failed; record the first failure below.

First failed step: ______________________________

What each screen said: ______________________________

Approximate playback positions on both computers: ______________________________

Did either player close or show an error? ______________________________

Screenshots or notes: ______________________________

Do not uninstall either copy after a failure until the failure details have been recorded.
