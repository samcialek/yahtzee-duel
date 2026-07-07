// public/js/uncertainty-ui.js
// Luck-vs-skill readout on the Variant step of the home screen.
//
// Fetches the precomputed public/uncertainty.json ONCE (tiny — no strategy table
// needed), then fills each variant card's split bar + caption. The split-bar
// number is one calculation per variant (see UNCERTAINTY.md): a perfect player's
// win rate against a near-perfect player, mapped skill% = 2×(win% − 50). The
// match-length figure is a second, points-based calculation: games until the
// perfect player is >95% likely to have the higher SUMMED score. Purely
// informational: if the fetch fails or the shape is off, the readouts hide
// themselves and the game still starts normally. Never alerts, never blocks.
//
// Binds only to the stable ids in index.html's DOM CONTRACT:
//   per variant i∈{1,2,3}: #unc-luck-i #unc-skill-i #unc-cap-i (#unc-bar-i)

const $ = (id) => document.getElementById(id);

const MODES = [1, 2, 3];

let variantsByMode = null;   // { mode -> variant } once loaded, else null

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

// Fetch the JSON once, reveal the readouts, and paint the bars. Resolves either
// way — failures fail soft (hide, no throw).
export async function init() {
  if (variantsByMode) { render(); return; }   // idempotent re-entry
  try {
    const res = await fetch('/uncertainty.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const variants = json && Array.isArray(json.variants) ? json.variants : null;
    if (!variants || !variants.length) throw new Error('no variants');

    const byMode = {};
    for (const v of variants) {
      if (v && MODES.includes(Number(v.mode))) byMode[Number(v.mode)] = v;
    }
    if (!Object.keys(byMode).length) throw new Error('no usable variants');

    variantsByMode = byMode;
    setReadoutsHidden(false);
    render();
  } catch (_err) {
    setReadoutsHidden(true);   // never surface an error to the player
  }
}

// Paint every variant card's split bar + caption. No-op until loaded.
export function render() {
  if (!variantsByMode) return;

  for (const mode of MODES) {
    const v = variantsByMode[mode];
    const luckEl = $(`unc-luck-${mode}`);
    const skillEl = $(`unc-skill-${mode}`);
    const capEl = $(`unc-cap-${mode}`);
    const gamesEl = $(`unc-games-${mode}`);
    if (!v) {
      if (luckEl) luckEl.style.width = '0%';
      if (skillEl) skillEl.style.width = '0%';
      if (capEl) capEl.textContent = '';
      if (gamesEl) gamesEl.textContent = '—';
      continue;
    }
    // Normalise the two shares so the bar always fills exactly 100% and the
    // caption reads a clean sum, even if the shipped numbers drift off 100.
    const { luck, skill } = split(v.luckPct, v.skillPct);
    // Widths transition via the .v-bar-seg CSS rule (or snap if reduced-motion).
    if (luckEl) luckEl.style.width = `${luck}%`;
    if (skillEl) skillEl.style.width = `${skill}%`;
    if (capEl) {
      // Lead with skill, emphasized; luck is the 1−skill remainder, shown small
      // and dim so the caption reads primarily as the skill share.
      capEl.textContent = '';
      capEl.append(span('skill', `${skill}% skill`), span('luck', `1 − ${luck}% luck`));
    }
    // Match length: games until perfect play is >95% likely to have the higher
    // SUMMED score (points-based; see UNCERTAINTY.md).
    if (gamesEl) {
      const g = Number(v.pointsGamesTo95);
      const valid = Number.isFinite(g) && g > 0;
      gamesEl.textContent = valid ? String(g) : '—';
      // Rewrite the hover so it names this card's own number (6 / 5 / 3),
      // not the static "about 6" placeholder baked into the HTML.
      const matchlen = gamesEl.parentElement;
      if (matchlen) {
        matchlen.title = valid
          ? `It takes about ${g} games before there's a 95% chance the better player has actually scored more points.`
          : '';
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function split(luckPct, skillPct) {
  const a = Number(luckPct);
  const e = Number(skillPct);
  const total = a + e;
  let luck = total > 0 && isFinite(total) ? Math.round((a / total) * 100) : 0;
  luck = Math.max(0, Math.min(100, luck));
  return { luck, skill: 100 - luck };
}

function span(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}

// Show/hide the whole informational block (explainer + per-card bars) without
// touching game-start controls. Uses the globally display:none [hidden].
function setReadoutsHidden(hidden) {
  const intro = document.querySelector('.unc-intro');
  if (intro) intro.hidden = hidden;
  for (const mode of MODES) {
    const bar = $(`unc-bar-${mode}`);
    const box = bar && bar.closest ? bar.closest('.v-unc') : null;
    if (box) box.hidden = hidden;
  }
}
