# AcornSwap Predict — design reference

## Figma

File: AcornSwap Interface,
<https://www.figma.com/design/oOPY8foOfB8hWept1yzgAC>
(file key `oOPY8foOfB8hWept1yzgAC`).

The **Prediction Market** page (node `85:15`) holds every Predict screen.
Node IDs were recorded on 2026-10-27; re-check them before relying on them.

| Row | x = 0 | x = 1540 | x = 3080 | x = 4620 | x = 6160 |
| --- | --- | --- | --- | --- | --- |
| y = 0, wallet connected | Predict · Markets | Market (detail) | Quests | Leaderboard | Rewards |
| y = 1500, guest | Markets · Guest | Market · Guest | | | |

The **Prediction · Components** frame (y = 2900) holds the Predict-specific
components:

- `PM/Outcome button` (Yes / No)
- `Predict/Subnav` (`Tab = Markets | Quests | Leaderboard | Rewards`)
- `XP chip`
- Table header + row for Markets, Leaderboard and Quests

The global header (`88:226`) has a `Nav/Predict` link.

The rest of the file (Cover, Foundations, Components, Swap, Explore, Pool,
Wallet) is the AcornSwap house style. Predict reuses its components first and
only adds the ones above.

## Design contract

A first draft (card grid, probability bars, category badges, icon boxes,
bookmark and trader icons, rail + inspector layout) was rejected as hard to
read and not minimal. The accepted design follows these rules; keep them in the
interface build.

- **One pattern per screen.** Lists are tables, laid out like the Explore page.
- **A Markets row is: question → one percentage → Yes / No.** About three facts
  and one action per row, never more.
- **Colours carry the outcome**: success green = Yes, alert red = No.
- **One plain line under each title** explains the rule in words, e.g. "a
  winning share pays 100 XP" (the amount is an assumption, `docs/PRODUCT.md`
  §2).
- No decorative bars, icon boxes, dashed frames, or numeric styling on text
  that is not a number.
- Guest screens (no wallet): banner with a QRL-orange title and white body, and
  "Connect wallet" in place of Buy.

## Theme

Same as the rest of AcornSwap; the interface already implements it in
`acorn-swap-interface/src/styles/tokens.css`.

- **Quantum Color**: obsidian ramp from `#08080a`, quantum blue `#4cc2ff` for
  interaction, QRL orange only on QRL identity marks, alert `#f2777a`.
- **Quantum Dimension** radii; **Acorn Dimension** `space/*` for padding.
- **Poppins** only, in Figma and in code. Numbers use tabular figures
  (`.mono` sets `tabular-nums`, not a monospace font).
- Screens are 1440 wide with a 1120 content column and a 72px header.
- Overlays (popovers, menus) use the elevated surface + strong border + modal
  elevation + a light scrim, never the card's own surface.
- Cards placed side by side fill / stretch to equal height.
