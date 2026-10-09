/**
 * The fixed colours of browser annotations (plan 20261009-annotator-vivid-colours): the boxes,
 * label and pins the page script draws over a page, and the number badges that mirror a pin in the
 * app's own UI. They are drawn on pages the app does not control, so they do not follow the app
 * theme or its light/dark appearance. Defined once here; the page script embeds them as text and
 * the renderer applies them as inline styles.
 */
export const ANNOTATOR_COLOURS = {
  accent: "#E6007A",
  onAccent: "#FFFFFF",
  success: "#14AE5C",
  onSuccess: "#FFFFFF",
  /** The thin ring outside every box, so it stands apart from any page background. */
  ring: "#FFFFFF",
} as const;
