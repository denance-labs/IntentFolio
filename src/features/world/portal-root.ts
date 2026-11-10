// D-571: where the app's portals land. Into the theme's root rather than <body>, so a portaled
// dialog or tooltip keeps the app's face (font-world and its --font-archivo variable live on that
// root and its parent, not on <body>) and the heading rules scoped to [data-app-theme]. The root
// has no transform or filter, so `fixed` inside it is still fixed to the viewport, which is what
// portaling was for. Outside the app (a test rendering one component) it falls back to <body>.
export function appPortalRoot(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-app-theme]") ?? document.body;
}
