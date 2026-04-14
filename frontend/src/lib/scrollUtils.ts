/**
 * scrollUtils.ts — DOM scroll helpers
 *
 * Thin wrappers around scrollIntoView so call-sites stay declarative.
 * All functions are side-effect only and never throw — safe to call
 * from event handlers without try/catch.
 */

/**
 * Smoothly scroll an element (identified by its DOM id) into the center
 * of the viewport.  No-ops silently if the element doesn't exist.
 */
export const scrollToElement = (id: string): void => {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
};
