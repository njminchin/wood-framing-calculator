// A small guided tour: dims the page, highlights one element at a time and
// shows an explanation card with Back / Next / Skip.
//
// steps: [{ target: '#css-selector' | null, title, text (HTML), before?: () => void }]
// A step with no target (or whose target isn't visible) shows the card centred.

const PAD = 6;   // space between the highlight and the element
const GAP = 12;  // space between the highlight and the card

export function startTour(steps, { onFinish } = {}) {
  let index = 0;
  let target = null;

  const blocker = el('div', 'tour-blocker');
  const spot = el('div', 'tour-spot');
  const card = el('div', 'tour-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  document.body.append(blocker, spot, card);

  function el(tag, cls) {
    const e = document.createElement(tag);
    e.className = cls;
    return e;
  }

  function visible(e) {
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function place() {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (target) {
      const r = target.getBoundingClientRect();
      Object.assign(spot.style, {
        display: 'block',
        left: `${r.left - PAD}px`, top: `${r.top - PAD}px`,
        width: `${r.width + 2 * PAD}px`, height: `${r.height + 2 * PAD}px`,
      });
      const cw = card.offsetWidth, ch = card.offsetHeight;
      let top = r.bottom + PAD + GAP;
      if (top + ch > vh - 8) top = r.top - PAD - GAP - ch;          // not enough room below: go above
      if (top < 8) top = Math.max(8, Math.min(vh - ch - 8, r.top)); // neither: overlap, keep on screen
      let left = r.left;
      if (r.width < cw) left = r.left + r.width / 2 - cw / 2;
      left = Math.max(8, Math.min(vw - cw - 8, left));
      Object.assign(card.style, { left: `${left}px`, top: `${top}px`, transform: 'none' });
    } else {
      spot.style.display = 'none';
      Object.assign(card.style, { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' });
    }
    blocker.classList.toggle('dim', !target); // the highlight's shadow does the dimming otherwise
  }

  function show(i) {
    index = i;
    const step = steps[i];
    if (step.before) step.before();
    const found = step.target ? document.querySelector(step.target) : null;
    target = visible(found) ? found : null;
    if (target) target.scrollIntoView({ block: 'center', inline: 'nearest' });
    const last = i === steps.length - 1;
    card.innerHTML = `
      <div class="tour-step">${i + 1} of ${steps.length}</div>
      <h3>${step.title}</h3>
      <div class="tour-text">${step.text}</div>
      <div class="tour-buttons">
        <button type="button" class="link" data-tour="skip">${last ? '' : 'Skip tour'}</button>
        <span class="spacer"></span>
        ${i > 0 ? '<button type="button" data-tour="back">Back</button>' : ''}
        <button type="button" class="primary" data-tour="next">${last ? 'Finish' : 'Next'}</button>
      </div>`;
    place();
    card.querySelector('[data-tour="next"]').focus();
  }

  function end() {
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    document.removeEventListener('keydown', onKey, true);
    blocker.remove(); spot.remove(); card.remove();
    if (onFinish) onFinish();
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); show(index - 1); }
  }

  function next() {
    if (index < steps.length - 1) show(index + 1);
    else end();
  }

  card.addEventListener('click', (e) => {
    const action = e.target.closest('[data-tour]')?.dataset.tour;
    if (action === 'next') next();
    else if (action === 'back') show(index - 1);
    else if (action === 'skip') end();
  });
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  document.addEventListener('keydown', onKey, true);
  show(0);
}
