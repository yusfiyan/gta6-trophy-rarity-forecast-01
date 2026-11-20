# gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/yusfiyan/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/yusfiyan/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts each Grand Theft Auto VI PlayStation 5 trophy's earn rate on Exophase at 2026-11-26T00:00:00Z as five quantiles, from the house's recorded reads of the trophy page.

## How it works

It works in counts, not rates: a trophy's rate is earners / players-tracked, and Exophase only moves its counts when it refreshes, so a case's history is a step function — flat reads, then a jump at each refresh. The jumps are the signal.

- **Flat history (the practice cases):** no read has moved, so it forecasts the next refresh. Launch night showed what one looks like: players tracked jumped 638 → 3,868 (x6.06) while trophies earned went 943 → 4,276, and all but 103 of the 3,333 new trophies are the one every player holds, so every other trophy's rate falls by dilution. Opening story trophies (ids 3–12) keep more of their earners than the rest.
- **Moving history (the final):** it fits two growth shapes to the players tracked and to each trophy's earners over the distinct reads — a power law in log-time and a saturating exponential — extrapolates both to the target, and takes the geometric mean of the two counts before forming the ratio. The gap between the shapes goes into the spread, the median is shrunk 15% toward the last read, and the spread also carries the fits' prediction variance plus a random-walk term.

Practice (local, against the refresh reconstructed from the kit's own figures): loss 0.09–0.13 across every plausible refresh shape, against the house baseline's ~1.51. Deterministic: two runs write byte-identical output.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=kgxbmb08&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>
