/* ==============================================================
   ICONS — the app's own glyph set.

   Deliberately *not* SF Symbols lookalikes. The house style is:
     - a heavier 2px stroke with round caps and joins
     - a small solid dot or wedge as a recurring accent
     - metaphors drawn from the app's subject (summits, compasses,
       horizons, flags) rather than the generic system vocabulary

   Everything inherits `currentColor`, so colour comes from CSS.

   Usage from a template string:  ${icon('plus')}
                                  ${icon('chevron-right','ic-sm')}
   ============================================================== */

const ICON_PATHS = {
  /* ---- Tab bar ----
     Each tab has a line version and a solid version; the tab bar swaps
     them on selection. These four carry most of the app's character. */

  /* Home — a sun clearing a horizon: what's ahead of you. */
  'home':      '<path d="M2.6 17.5h18.8"/><path d="M6 17.5a6 6 0 0 1 12 0"/><path d="M12 3.4v2.4M4.7 6.6 6.4 8.3M19.3 6.6 17.6 8.3M2.8 13.4h1.9M19.3 13.4h1.9"/>',
  'home-fill': '<path d="M6 17.4a6 6 0 0 1 12 0z" fill="currentColor" stroke="none"/><path d="M2.6 17.5h18.8" stroke="currentColor" stroke-width="2.1"/><path d="M12 3.4v2.4M4.7 6.6 6.4 8.3M19.3 6.6 17.6 8.3M2.8 13.4h1.9M19.3 13.4h1.9" stroke="currentColor" stroke-width="2.1"/>',

  /* Lists — stacked cards, i.e. collections rather than a bullet list. */
  'stack':      '<rect x="3.2" y="9.4" width="17.6" height="11.4" rx="2.6"/><path d="M5.8 6.4h12.4M8.2 3.4h7.6"/>',
  'stack-fill': '<rect x="3.2" y="9.4" width="17.6" height="11.4" rx="2.6" fill="currentColor" stroke="none"/><path d="M5.8 6.4h12.4M8.2 3.4h7.6" stroke="currentColor" stroke-width="2.1"/>',

  /* Map — a compass rose. Far more characterful than a globe. */
  'compass':      '<circle cx="12" cy="12" r="9"/><path d="M15.6 8.4 13.9 13.9 8.4 15.6 10.1 10.1z"/>',
  'compass-fill': '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="M15.6 8.4 13.9 13.9 8.4 15.6 10.1 10.1z" fill="var(--nav-bg)" stroke="none"/>',

  /* Me — a summit with a planted flag. */
  'summit':      '<path d="M2.8 19.6h18.4"/><path d="M3.6 19.6 9.4 9.2l3.1 5.2"/><path d="M16.4 19.6V4.2"/><path d="M16.4 5.2c1.8-1 3.6.9 5.4 0v4.4c-1.8.9-3.6-1-5.4 0z"/>',
  'summit-fill': '<path d="M2.8 19.6h18.4" stroke="currentColor" stroke-width="2.1"/><path d="M3.4 19.6 9.4 9 13 15z" fill="currentColor" stroke="none"/><path d="M16.4 19.6V4.2" stroke="currentColor" stroke-width="2.1"/><path d="M16.4 5.2c1.8-1 3.6.9 5.4 0v4.4c-1.8.9-3.6-1-5.4 0z" fill="currentColor" stroke="none"/>',

  /* ---- Navigation ---- */
  'chevron-left':  '<path d="M15 4.6 7.8 12l7.2 7.4"/>',
  'chevron-right': '<path d="M9 4.6 16.2 12 9 19.4"/>',
  'chevron-down':  '<path d="M4.8 8.6 12 15.8l7.2-7.2"/>',
  'plus':          '<path d="M12 4.6v14.8M4.6 12h14.8"/>',
  'x':             '<path d="M5.8 5.8l12.4 12.4M18.2 5.8 5.8 18.2"/>',
  /* Overflow: three dots with the middle one larger — a small tell that
     these are hand-made rather than system-issue. */
  'ellipsis':      '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  'search':        '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4 20.6 20.6"/>',

  /* ---- State ---- */
  'circle':       '<circle cx="12" cy="12" r="8.8"/>',
  'check-circle': '<circle cx="12" cy="12" r="9.6" fill="currentColor" stroke="none"/><path d="M7.6 12.3 10.6 15.4 16.4 9.1" stroke="var(--bg-elevated)" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  'check':        '<path d="M4.8 12.6 9.6 17.4 19.2 6.8"/>',

  /* ---- Content ---- */
  'photo':    '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="8.6" cy="10" r="1.7" fill="currentColor" stroke="none"/><path d="M3.8 17.6 9 12.6a2 2 0 0 1 2.8 0l6.2 6"/>',
  'camera':   '<path d="M3 9a3 3 0 0 1 3-3h1.4l1.2-2h6.8l1.2 2H19a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/><circle cx="12.5" cy="13" r="3.6"/>',
  /* Solid triangle: it sits on top of a photo, where a stroked outline
     disappears into whatever is behind it. */
  'play':     '<path d="M8.4 5.6 19 12 8.4 18.4z" fill="currentColor" stroke="none"/>',
  'video':    '<rect x="2.6" y="6" width="13.4" height="12" rx="3"/><path d="M16 11.2l4.2-2.7a.8.8 0 0 1 1.2.7v5.6a.8.8 0 0 1-1.2.7L16 12.8z"/>',
  'trash':    '<path d="M4.4 6.6h15.2M9.4 6.6V4.9a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v1.7"/><path d="M6.4 6.6l.9 12.5a1.8 1.8 0 0 0 1.8 1.7h5.8a1.8 1.8 0 0 0 1.8-1.7l.9-12.5"/><path d="M10 10.4v6.2M14 10.4v6.2"/>',
  'pencil':   '<path d="M4 20l.9-4.3L15.6 5a2.1 2.1 0 0 1 3 0l1.4 1.4a2.1 2.1 0 0 1 0 3L9.3 20.1z"/><path d="M14 6.8 17.2 10"/>',
  'link':     '<path d="M10.2 13.8a3.9 3.9 0 0 0 5.5 0l3-3a3.9 3.9 0 1 0-5.5-5.5l-1.4 1.4"/><path d="M13.8 10.2a3.9 3.9 0 0 0-5.5 0l-3 3a3.9 3.9 0 1 0 5.5 5.5l1.4-1.4"/>',
  'calendar': '<rect x="3.4" y="5" width="17.2" height="15.6" rx="3"/><path d="M3.4 9.8h17.2M8 3.2v3.4M16 3.2v3.4"/><circle cx="8.4" cy="14" r="1.3" fill="currentColor" stroke="none"/>',
  /* Location — teardrop with a solid centre, matching the marker style. */
  'pin':      '<path d="M12 21.4S19 15 19 10.2a7 7 0 1 0-14 0C5 15 12 21.4 12 21.4z"/><circle cx="12" cy="10.1" r="2.4" fill="currentColor" stroke="none"/>',
  'flag':     '<path d="M5.6 21V3.6"/><path d="M5.6 4.6c2.4-1.3 4.8 1.2 7.2 0s4.8 1.2 7.2 0v8.8c-2.4 1.2-4.8-1.3-7.2 0s-4.8-1.2-7.2 0z"/>',
  'square-grid':'<rect x="3.4" y="3.4" width="7.4" height="7.4" rx="2.4"/><rect x="13.2" y="3.4" width="7.4" height="7.4" rx="2.4"/><rect x="3.4" y="13.2" width="7.4" height="7.4" rx="2.4"/><rect x="13.2" y="13.2" width="7.4" height="7.4" rx="2.4"/>',
  'rows':     '<rect x="3.4" y="4.4" width="17.2" height="6.2" rx="2.4"/><rect x="3.4" y="13.4" width="17.2" height="6.2" rx="2.4"/>',
  'map':      '<path d="M3.4 6.6 9 4.2v13.2l-5.6 2.4zM9 4.2l6 2.4v13.2L9 17.4zM15 6.6l5.6-2.4v13.2L15 19.8z"/>',
  'folder':   '<path d="M3.4 7.4a2.4 2.4 0 0 1 2.4-2.4h3a2.4 2.4 0 0 1 1.8.8l1.2 1.4h6.8a2.4 2.4 0 0 1 2.4 2.4v8.6a2.4 2.4 0 0 1-2.4 2.4H5.8a2.4 2.4 0 0 1-2.4-2.4z"/>',
  'share':    '<path d="M12 15.6V3.4M8 7.4 12 3.4l4 4"/><path d="M6.2 11.4H5a1.6 1.6 0 0 0-1.6 1.6v6.4A1.6 1.6 0 0 0 5 21h14a1.6 1.6 0 0 0 1.6-1.6V13a1.6 1.6 0 0 0-1.6-1.6h-1.2"/>',
  'undo':     '<path d="M4 9.4h9.6a5.6 5.6 0 1 1 0 11.2H8"/><path d="M7.8 5 3.4 9.4l4.4 4.4"/>',
  'signout':  '<path d="M15 8V6a2.2 2.2 0 0 0-2.2-2.2H6.4A2.2 2.2 0 0 0 4.2 6v12a2.2 2.2 0 0 0 2.2 2.2h6.4A2.2 2.2 0 0 0 15 18v-2"/><path d="M9.6 12h11M17.2 8.4 20.8 12l-3.6 3.6"/>',
  /* A four-point star — used for empty states and "someday" moments. */
  'sparkle':  '<path d="M12 2.6c.6 4.6 2.2 6.2 6.8 6.8-4.6.6-6.2 2.2-6.8 6.8-.6-4.6-2.2-6.2-6.8-6.8 4.6-.6 6.2-2.2 6.8-6.8z"/><path d="M18.4 15.4c.3 2.2 1.1 3 3.3 3.3-2.2.3-3 1.1-3.3 3.3-.3-2.2-1.1-3-3.3-3.3 2.2-.3 3-1.1 3.3-3.3z"/>',
  'clock':    '<circle cx="12" cy="12" r="8.8"/><path d="M12 6.8V12l3.6 2.2"/>',
  'target':   '<circle cx="12" cy="12" r="8.8"/><circle cx="12" cy="12" r="4.4"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  'locate':   '<circle cx="12" cy="12" r="3.4"/><path d="M12 2.6v3.2M12 18.2v3.2M2.6 12h3.2M18.2 12h3.2"/><circle cx="12" cy="12" r="8"/>',
  'layers':   '<path d="M12 3.2 2.8 8 12 12.8 21.2 8z"/><path d="M2.8 13.2 12 18l9.2-4.8"/>',
};

/* Icons whose art is already solid and must not be given a stroke. */
const ICON_FILLED = new Set([
  'home-fill', 'stack-fill', 'compass-fill', 'summit-fill',
  'check-circle', 'ellipsis', 'play',
]);

function icon(name, cls) {
  const d = ICON_PATHS[name];
  if (!d) { console.warn('[icon] unknown icon:', name); return ''; }
  const attrs = ICON_FILLED.has(name)
    ? 'fill="none" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" ${attrs} aria-hidden="true">${d}</svg>`;
}
