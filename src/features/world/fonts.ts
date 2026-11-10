import { Archivo } from "next/font/google";

// D-568: the world's face (landing, /learn and, since D-571, the app). Variable on weight and
// width: wide for the wordmark and the headings, normal for running text. Declared here and not
// in the root layout so that only the routes that render the world download and preload it.
export const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});
