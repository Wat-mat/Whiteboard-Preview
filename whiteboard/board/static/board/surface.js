'use strict';

// Pan, zoom and drag for a whiteboard. Used by the main board and every project's mini board.

const MIN_SCALE = 0.1;
const MAX_SCALE = 2;
const DRAG_THRESHOLD = 4; // px of movement before a press counts as a drag, not a click

/**
 * viewport: the clipping element that receives pointer events.
 * canvas: the element inside it that gets the pan/zoom transform.
 * opts.bounds() -> {x, y, w, h}: content box used by fit().
 * opts.beginDrag(el) -> {move(dx, dy), end(moved, cancelled)}: called for elements marked
 *   with data-drag; dx/dy are in board units, end(false, false) means it was a click.
 * opts.storageKey: where to remember the view between visits (optional).
 * opts.firstView(width, height) -> view or null: starting view when nothing is saved (optional; default fit).
 * opts.onView(view): called after every pan or zoom (optional).
 */
function createSurface(viewport, canvas, opts) {
  let view = { x: 0, y: 0, s: 1 };

  function apply() {
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
    viewport.style.backgroundSize = `${24 * view.s}px ${24 * view.s}px`;
    viewport.style.backgroundPosition = `${view.x}px ${view.y}px`;
    if (opts.onView) opts.onView(view);
    if (opts.storageKey) storageSet(opts.storageKey, view);
  }

  function clampScale(s) {
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  function zoomAt(mx, my, scale) {
    const s = clampScale(scale);
    const bx = (mx - view.x) / view.s;
    const by = (my - view.y) / view.s;
    view = { x: mx - bx * s, y: my - by * s, s };
    apply();
  }

  function zoomBy(factor) {
    zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, view.s * factor);
  }

  // Returns false when the viewport is hidden (zero size), so callers can retry once it shows.
  function fit() {
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (!vw || !vh) return false;
    const b = opts.bounds();
    const margin = 24;
    const s = clampScale(Math.min((vw - margin * 2) / b.w, (vh - margin * 2) / b.h, 1));
    view = {
      s,
      x: (vw - b.w * s) / 2 - b.x * s,
      y: Math.max(margin, (vh - b.h * s) / 2) - b.y * s,
    };
    apply();
    return true;
  }

  function restore() {
    const saved = opts.storageKey ? storageGet(opts.storageKey) : null;
    if (saved && [saved.x, saved.y, saved.s].every(Number.isFinite)) {
      view = saved;
      apply();
      return true;
    }
    const first = opts.firstView && viewport.clientWidth ? opts.firstView(viewport.clientWidth, viewport.clientHeight) : null;
    if (first) {
      view = first;
      apply();
      return true;
    }
    return fit();
  }

  function centerOn(bx, by, minScale = view.s) {
    const s = clampScale(Math.max(view.s, minScale));
    view = { s, x: viewport.clientWidth / 2 - bx * s, y: viewport.clientHeight / 2 - by * s };
    apply();
  }

  // Board coordinates of the middle of what is on screen.
  function viewCenter() {
    return {
      x: (viewport.clientWidth / 2 - view.x) / view.s,
      y: (viewport.clientHeight / 2 - view.y) / view.s,
    };
  }

  function localPoint(e) {
    const r = viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // One pointer on a draggable drags it, one on the background pans, two pinch-zoom.
  const pointers = new Map();
  let gesture = null;

  function cancelDrag() {
    if (gesture && gesture.type === 'drag') gesture.drag.end(gesture.moved, true);
  }

  viewport.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button, input, select, textarea, a')) return;
    try { viewport.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    pointers.set(e.pointerId, localPoint(e));

    if (pointers.size === 2) {
      cancelDrag();
      const [a, b] = [...pointers.values()];
      gesture = {
        type: 'pinch',
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        view: { ...view },
      };
      return;
    }
    const start = localPoint(e);
    const target = e.target.closest('[data-drag]');
    if (target && canvas.contains(target)) {
      gesture = { type: 'drag', drag: opts.beginDrag(target), start, moved: false };
    } else {
      gesture = { type: 'pan', start, view: { ...view } };
      viewport.classList.add('panning');
    }
  });

  viewport.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    const pt = localPoint(e);
    pointers.set(e.pointerId, pt);

    if (gesture.type === 'drag') {
      const dx = pt.x - gesture.start.x;
      const dy = pt.y - gesture.start.y;
      if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      gesture.moved = true;
      gesture.drag.move(dx / view.s, dy / view.s);
    } else if (gesture.type === 'pan') {
      view.x = gesture.view.x + pt.x - gesture.start.x;
      view.y = gesture.view.y + pt.y - gesture.start.y;
      apply();
    } else if (gesture.type === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const g = gesture;
      const s = clampScale(g.view.s * Math.hypot(a.x - b.x, a.y - b.y) / g.dist);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const bx = (g.mid.x - g.view.x) / g.view.s;
      const by = (g.mid.y - g.view.y) / g.view.s;
      view = { s, x: mid.x - bx * s, y: mid.y - by * s };
      apply();
    }
  });

  function endPointer(e) {
    if (!pointers.delete(e.pointerId)) return;
    viewport.classList.remove('panning');
    const g = gesture;
    gesture = null;
    if (g && g.type === 'drag') g.drag.end(g.moved, e.type === 'pointercancel');
  }
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);

  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    const pt = localPoint(e);
    zoomAt(pt.x, pt.y, view.s * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  function panBy(dx, dy) {
    view = { ...view, x: view.x + dx, y: view.y + dy };
    apply();
  }

  return { apply, zoomBy, panBy, fit, restore, centerOn, viewCenter, get view() { return view; } };
}

// Drag behaviour for a project card element (data-id = project id).
// A press without movement opens the project.
// The card snaps to the board grid as it moves; onMove(p) lets the board highlight where it would land.
function cardDrag(el, onDrop, onMove = null) {
  const p = projectById(Number(el.dataset.id));
  const orig = { x: p.x, y: p.y };
  return {
    move(dx, dy) {
      el.classList.add('dragging');
      p.x = snap(orig.x + dx);
      p.y = snap(orig.y + dy);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      if (onMove) onMove(p);
    },
    end(moved, cancelled) {
      el.classList.remove('dragging');
      if (onMove) onMove(null);
      if (cancelled) {
        Object.assign(p, orig);
        render();
      } else if (moved) {
        onDrop(p);
      } else {
        openProject(p);
      }
    },
  };
}
