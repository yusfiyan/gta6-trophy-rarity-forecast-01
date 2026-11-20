// gta6-trophy-rarity-forecast-01 — count-consistent dilution + growth forecaster.
//
// A trophy's earn rate is earners / players-tracked, so this program works in
// COUNTS, not rates. Exophase only moves its counts when it refreshes, so a
// case's history is a step function: flat reads, then a jump at each refresh.
// The jumps are the signal; the flat stretches carry none.
//
// Flat history (the practice cases): no read has moved, so the only thing to
// forecast is the next refresh. Launch night showed what one looks like:
// players tracked jumped 638 -> 3,868 (x6.06) while trophies earned went
// 943 -> 4,276. All but 103 of the 3,333 new trophies are the one every
// player holds (trophy 2, 100%), so every other trophy's earners barely
// grew and its rate fell by dilution, ~x0.165, with the opening story
// trophies (ids 3..12) keeping more of their earners (x~0.30). The factors
// below are the robust middle of that range: calibrated on the practice
// cases against the house baseline's stated ~1.51, they score ~0.12-0.13
// worst-case across every plausible refresh shape (pure dilution, the 103
// spread over all trophies, or concentrated in the opening trophies).
//
// Moving history (the final): fit TWO growth shapes to the players tracked
// and to each trophy's earners over the distinct reads — a power law in
// log-time, and a saturating exponential — extrapolate both to the target,
// and take the geometric mean of the two counts before forming the ratio.
// A power law alone overshoots when growth saturates (launch growth always
// does); a saturating curve alone undershoots while growth is still fast.
// The gap between the two shapes is real uncertainty, so half of it goes
// into the spread. Shrink the logit-median 15% of the way toward the last
// read (persistence) as a hedge against over-extrapolation, and set the
// spread from the fits' prediction variance, the shape gap, and a modest
// random-walk term that grows with the horizon.
//
// A trophy at 100% in every read stays 100%.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Flat history: opening story trophies (ids 3..12) keep this much of their rate. */
const FLAT_EARLY_FACTOR = 0.3;
/** Flat history: every other trophy keeps this much of its rate. */
const FLAT_LATE_FACTOR = 0.18;
/** Last id counted as an opening story trophy (id 2 is the 100% one). */
const FLAT_EARLY_LAST_ID = 12;
/** Flat history: logit spread of the forecast at the practice horizon. */
const FLAT_SIGMA0 = 0.3;
/** Logit spread per square-root day, the random-walk term. */
const RW_SIGMA = 0.5;
/** Rich history: weight on the last read when shrinking the logit-median. */
const SHRINK_TO_LAST = 0.15;
/** Rich history: random-walk logit spread per square-root day (half the
 *  no-information rate: the model already carries the trend). */
const RICH_RW_SIGMA = 0.25;
/** Cap on fitted power-law exponents, against explosive extrapolation. */
const MAX_EXPONENT = 1.5;
/** Floor on a fit's residual std, so a 2-point fit still carries uncertainty. */
const RESID_FLOOR = 0.15;
/** Bounds on the logit spread of any row. */
const SIGMA_MIN = 0.25;
const SIGMA_MAX = 1.8;

interface Trophy {
  id: number;
  name: string;
  tier: string;
}

interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface Case {
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: Trophy[];
  history: Read[];
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
/** A rate clamped to where the logit is defined, as the scorer clamps it. */
const clampRate = (x: number): number => clamp(x, 0.01, 99.99);
const logit = (pct: number): number => {
  const p = clampRate(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10000) / 10000;

interface Fit {
  slope: number;
  intercept: number;
  resid: number;
  xbar: number;
  sxx: number;
  n: number;
}

/** Least squares of y on x. */
function ols(xs: number[], ys: number[]): Fit {
  const n = xs.length;
  const xbar = xs.reduce((a, b) => a + b, 0) / n;
  const ybar = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let j = 0; j < n; j++) {
    sxx += (xs[j] - xbar) ** 2;
    sxy += (xs[j] - xbar) * (ys[j] - ybar);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = ybar - slope * xbar;
  let rss = 0;
  for (let j = 0; j < n; j++) {
    const r = ys[j] - (intercept + slope * xs[j]);
    rss += r * r;
  }
  const resid = n > 2 ? Math.sqrt(rss / (n - 2)) : 0;
  return { slope, intercept, resid, xbar, sxx, n };
}

/**
 * Prediction std of a fitted line at xStar: the residual std, floored, times
 * the leverage of extrapolating there, so the spread grows as the target
 * leaves the data behind.
 */
function predStd(fit: Fit, xStar: number): number {
  const s = Math.max(fit.resid, RESID_FLOOR);
  const lev = 1 + 1 / fit.n + (fit.sxx > 0 ? (xStar - fit.xbar) ** 2 / fit.sxx : 0);
  return s * Math.sqrt(lev);
}

/**
 * Saturating-exponential fit C(t) = K (1 - exp(-t/tau)), tau by grid search
 * (K solved linearly per tau). Growth after a launch saturates; this is the
 * shape a power law cannot express, so the rich branch blends the two.
 */
function satFit(ts: number[], cs: number[]): { k: number; tau: number } {
  let best = { k: 0, tau: 0, sse: Infinity };
  for (let g = 0; g <= 60; g++) {
    const tau = 4 * Math.pow(750, g / 60);
    let num = 0;
    let den = 0;
    for (let j = 0; j < ts.length; j++) {
      const b = 1 - Math.exp(-ts[j] / tau);
      num += cs[j] * b;
      den += b * b;
    }
    const k = den > 0 ? num / den : 0;
    let sse = 0;
    for (let j = 0; j < ts.length; j++) {
      const b = 1 - Math.exp(-ts[j] / tau);
      const r = cs[j] - k * b;
      sse += r * r;
    }
    if (sse < best.sse) best = { k, tau, sse };
  }
  return best;
}

/** Five quantiles around a median rate, non-decreasing after rounding. */
function quantiles(medianPct: number, sigma: number): number[] {
  const l = logit(medianPct);
  const qs = Z.map((z) => round4(clamp(invLogit(l + z * sigma), 0.01, 100)));
  for (let k = 1; k < qs.length; k++) if (qs[k] < qs[k - 1]) qs[k] = qs[k - 1];
  return qs;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const horizonDays = c.horizon_minutes / 1440;

  // Reads: times in hours since the first read, players, per-trophy earners.
  const t0 = Date.parse(c.history[0].at);
  const times: number[] = [];
  const players: number[] = [];
  const earners: number[][] = c.trophies.map(() => []);
  // Each trophy's rate in the last read that lists it.
  const lastRate: number[] = c.trophies.map((_, i) => {
    for (let j = c.history.length - 1; j >= 0; j--) {
      const r = c.history[j].rates[i];
      if (r !== null && r !== undefined) return r;
    }
    return 0;
  });
  for (const read of c.history) {
    times.push((Date.parse(read.at) - t0) / 3600000);
    players.push(read.players_tracked);
    read.rates.forEach((r, i) => {
      earners[i].push(r === null || r === undefined ? NaN : Math.round((r / 100) * read.players_tracked));
    });
  }
  // Distinct reads: collapse consecutive reads with identical players + rates.
  // The page only moves at a refresh, so these are the refresh points.
  const distinct: number[] = [];
  for (let j = 0; j < c.history.length; j++) {
    if (j === 0) {
      distinct.push(j);
      continue;
    }
    const prev = distinct[distinct.length - 1];
    const samePlayers = players[j] === players[prev];
    const sameRates = c.history[j].rates.every((r, i) => r === c.history[prev].rates[i]);
    if (!samePlayers || !sameRates) distinct.push(j);
  }
  const tStar = (Date.parse(c.target) - t0) / 3600000;
  const xStar = Math.log(1 + Math.max(0, tStar));

  const rows: Array<{ id: number; q: number[] }> = [];
  if (distinct.length <= 1) {
    // Flat history: forecast the next refresh (the dilution prior). The
    // spread widens past the practice horizon, like a random walk's.
    const extra = RW_SIGMA * Math.sqrt(Math.max(0, horizonDays - 1 / 16));
    const sigma = Math.sqrt(FLAT_SIGMA0 ** 2 + extra ** 2);
    c.trophies.forEach((t, i) => {
      const r = lastRate[i];
      if (r >= 100) {
        rows.push({ id: t.id, q: [100, 100, 100, 100, 100] });
        return;
      }
      const factor = t.id >= 3 && t.id <= FLAT_EARLY_LAST_ID ? FLAT_EARLY_FACTOR : FLAT_LATE_FACTOR;
      rows.push({ id: t.id, q: quantiles(r * factor, sigma) });
    });
  } else {
    // Moving history: two growth shapes on the distinct reads, blended.
    const xs = distinct.map((j) => Math.log(1 + Math.max(0, times[j])));
    const tVals = distinct.map((j) => Math.max(0, times[j]));
    const nVals = distinct.map((j) => players[j]);
    const logN = nVals.map((n) => Math.log(Math.max(1, n)));
    const fitN = ols(xs, logN);
    const bN = clamp(fitN.slope, 0, MAX_EXPONENT);
    const predN = predStd(fitN, xStar);
    const nStarPl = Math.exp(fitN.intercept + bN * xStar);
    const satN = satFit(tVals, nVals);
    const nStarSe = Math.max(1, satN.k * (1 - Math.exp(-Math.max(0, tStar) / satN.tau)));
    const nStar = Math.exp(0.5 * (Math.log(Math.max(1, nStarPl)) + Math.log(nStarSe)));
    const rw = RICH_RW_SIGMA * Math.sqrt(horizonDays);
    c.trophies.forEach((t, i) => {
      const r = lastRate[i];
      const allHundred = c.history.every((read) => read.rates[i] === 100);
      if (allHundred) {
        rows.push({ id: t.id, q: [100, 100, 100, 100, 100] });
        return;
      }
      // This trophy's earners on the distinct reads where it is present.
      const ex: number[] = [];
      const ey: number[] = [];
      const et: number[] = [];
      const ec: number[] = [];
      for (const j of distinct) {
        const e = earners[i][j];
        if (!Number.isNaN(e)) {
          const tt = Math.max(0, times[j]);
          ex.push(Math.log(1 + tt));
          ey.push(Math.log(e + 0.5));
          et.push(tt);
          ec.push(e);
        }
      }
      let modelRate: number;
      let sigFit: number;
      if (ex.length >= 2) {
        const fitE = ols(ex, ey);
        const bE = clamp(fitE.slope, 0, MAX_EXPONENT);
        const eStarPl = Math.max(0, Math.exp(fitE.intercept + bE * xStar) - 0.5);
        const satE = satFit(et, ec);
        const eStarSe = Math.max(0, satE.k * (1 - Math.exp(-Math.max(0, tStar) / satE.tau)));
        const eStar = Math.exp(0.5 * (Math.log(eStarPl + 0.5) + Math.log(eStarSe + 0.5))) - 0.5;
        const ratePl = clampRate((100 * Math.min(eStarPl, nStarPl)) / Math.max(1, nStarPl));
        const rateSe = clampRate((100 * Math.min(eStarSe, nStarSe)) / Math.max(1, nStarSe));
        modelRate = clampRate((100 * Math.min(Math.max(0, eStar), nStar)) / Math.max(1, nStar));
        // Half the log gap between the two shapes is shape uncertainty.
        const dRate = Math.abs(Math.log(ratePl / rateSe));
        sigFit = Math.sqrt(predStd(fitE, xStar) ** 2 + predN ** 2 + (dRate / 2) ** 2);
      } else {
        // Too little signal for this trophy: hold its last rate, wide spread.
        modelRate = r;
        sigFit = 0.8;
      }
      const medLogit = (1 - SHRINK_TO_LAST) * logit(modelRate) + SHRINK_TO_LAST * logit(r);
      const median = clampRate(invLogit(medLogit));
      const sigma = clamp(Math.sqrt(sigFit ** 2 + rw ** 2), SIGMA_MIN, SIGMA_MAX);
      rows.push({ id: t.id, q: quantiles(median, sigma) });
    });
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies: rows })}\n`);
}
