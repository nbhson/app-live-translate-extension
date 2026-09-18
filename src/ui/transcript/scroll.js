import { DOM } from '../dom.js';

let scrollScheduled = false;
let pendingForce = false;
let pendingBehavior = 'smooth';
let shouldStickToTop = true;

export function isNearTop() {
  const el = DOM.transcriptContent;
  if (!el) return true;
  return el.scrollTop < 120;
}

export function setShouldStick(v) { shouldStickToTop = !!v; }
export function getShouldStick() { return shouldStickToTop; }

export function autoScroll(force = false, behavior = 'smooth') {
  if (force) { pendingForce = true; pendingBehavior = 'smooth'; }
  else if (behavior === 'smooth') pendingBehavior = 'smooth';
  else if (pendingBehavior !== 'smooth') pendingBehavior = behavior;

  const chk = document.getElementById('autoScrollCheck');
  const enabled = !!(chk && chk.checked);
  if (!enabled) return;
  if (!force && !shouldStickToTop && !isNearTop()) return;
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    const mustForce = pendingForce;
    const beh = pendingBehavior;
    pendingForce = false; pendingBehavior = 'smooth';
    const el = DOM.transcriptContent;
    if (!el || !enabled) return;
    if (mustForce || shouldStickToTop || isNearTop()) el.scrollTo({ top: 0, behavior: beh });
  });
}
