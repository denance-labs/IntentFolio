// Shown inside <noscript> on the app routes (D-566b). Without JavaScript the app cannot sign
// anyone in or load anything, and the language switch does not work either, so both languages
// are shown together.
export const noJavaScriptNotice = {
  en: {
    title: "IntentFolio needs JavaScript",
    body: "The app signs you in with your wallet and loads your portfolio in the browser. Turn JavaScript on and reload this page.",
    back: "Back to the home page"
  },
  es: {
    title: "IntentFolio necesita JavaScript",
    body: "La app inicia sesión con tu wallet y carga tu portfolio en el navegador. Activá JavaScript y recargá esta página.",
    back: "Volver al inicio"
  }
} as const;
