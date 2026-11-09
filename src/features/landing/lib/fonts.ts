import { Archivo } from "next/font/google";

// D-568: the landing's own face. Variable on weight and width: wide for the wordmark and the
// headings, normal for running text. Declared here and not in the root layout so that only the
// routes that render the landing world (the landing and /learn) download and preload it; the app
// keeps its system font until it adopts this look in its own item.
export const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});
