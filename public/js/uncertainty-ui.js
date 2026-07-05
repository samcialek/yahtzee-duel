// public/js/uncertainty-ui.js
// Luck-vs-skill readout on the Variant step of the home screen.
//
// Fetches the precomputed public/uncertainty.json ONCE (tiny — no strategy table
// needed), then fills each variant card's split bar + caption from the active
// skill-spread's per-variant aleatory/epistemic split, and wires the spread
// selector (#seg-spread) to re-render on change. Purely informational: if the
// fetch fails or the shape is off, the readouts hide themselves and the game
// still starts normally. Never alerts, never blocks.
//
// Binds only to the stable ids in index.html's DOM CONTRACT:
//   #seg-spread + #spread-{experts,mixed,novices}  (data-spread)
//   per variant i∈{1,2,3}: #unc-luck-i #unc-skill-i #unc-cap-i (#unc-bar-i)

const $ = (id) => document.getElementById(id);

const MODES = [1, 2, 3];
const DEFAULT_SPREAD = 'mixed';

let spreadsByKey = null;   // { key -> spread } once loaded, else null
let defaultKey = DEFAULT_SPREAD;
let wired = false;         // spread-selector listener attached once

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

// Fetch the JSON once, reveal the readouts, wire the spread selector, and paint
// the default spread. Resolves either way — failures fail soft (hide, no throw).
export async function init() {
  if (spreadsByKey) { render(defaultKey); return; }   // idempotent re-entry
  try {
    const res = await fetch('/uncertainty.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const spreads = json && Array.isArray(json.spreads) ? json.spreads : null;
    if (!spreads || !spreads.length) throw new Error('no spreads');

    const byKey = {};
    for (const sp of spreads) {
      if (sp && typeof sp.key === 'string' && Array.isArray(sp.variants)) {
        byKey[sp.key] = sp;
        if (sp.default) defaultKey = sp.key;
      }
    }
    if (!Object.keys(byKey).length) throw new Error('no usable spreads');
    if (!byKey[defaultKey]) defaultKey = byKey[DEFAULT_SPREAD] ? DEFAULT_SPREAD : Object.keys(byKey)[0];

    spreadsByKey = byKey;
    setReadoutsHidden(false);
    wireSpreadSelector();
    render(defaultKey);
  } catch (_err) {
    setReadoutsHidden(true);   // never surface an error to the player
  }
}

// Paint every variant card's split bar + caption from `spreadKey`'s data and
// reflect the selection on the spread segmented control. No-op until loaded.
export function render(spreadKey) {
  if (!spreadsByKey) return;
  const spread = spreadsByKey[spreadKey] || spreadsByKey[defaultKey];
  if (!spread) return;

  // Reflect the active spread on the segmented selector.
  const seg = $('seg-spread');
  if (seg) {
    for (const btn of seg.querySelectorAll('[data-spread]')) {
      btn.classList.toggle('is-selected', btn.dataset.spread === spread.key);
    }
  }

  for (const mode of MODES) {
    const v = spread.variants.find((x) => x && Number(x.mode) === mode);
    const luckEl = $(`unc-luck-${mode}`);
    const skillEl = $(`unc-skill-${mode}`);
    const capEl = $(`unc-cap-${mode}`);
    if (!v) {
      if (luckEl) luckEl.style.width = '0%';
      if (skillEl) skillEl.style.width = '0%';
      if (capEl) capEl.textContent = '';
      continue;
    }
    // Normalise the two shares so the bar always fills exactly 100% and the
    // caption reads a clean sum, even if the MC percentages drift off 100.
    const { luck, skill } = split(v.aleatoryPct, v.epistemicPct);
    // Widths transition via the .v-bar-seg CSS rule (or snap if reduced-motion).
    if (luckEl) luckEl.style.width = `${luck}%`;
    if (skillEl) skillEl.style.width = `${skill}%`;
    if (capEl) {
      capEl.textContent = '';
      capEl.append(span('luck', `${luck}% luck`), document.createTextNode(' · '), span('skill', `${skill}% skill`));
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function split(aleatoryPct, epistemicPct) {
  const a = Number(aleatoryPct);
  const e = Number(epistemicPct);
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

function wireSpreadSelector() {
  if (wired) return;
  const seg = $('seg-spread');
  if (!seg) return;
  seg.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-spread]') : null;
    if (!btn || !seg.contains(btn)) return;
    render(btn.dataset.spread);
  });
  wired = true;
}

// Show/hide the whole informational block (explainer + selector + per-card bars)
// without touching game-start controls. Uses the globally display:none [hidden].
function setReadoutsHidden(hidden) {
  const intro = document.querySelector('.unc-intro');
  if (intro) intro.hidden = hidden;
  for (const mode of MODES) {
    const bar = $(`unc-bar-${mode}`);
    const box = bar && bar.closest ? bar.closest('.v-unc') : null;
    if (box) box.hidden = hidden;
  }
}
