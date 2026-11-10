import type { Config } from "tailwindcss";

// The app's colors read CSS variables (globals.css), so its whole look is retuned from a handful
// of lines there (D-571): the slate steps carry depth and text, `accent` is what you act on and
// `target` marks targets. The `<alpha-value>` placeholder keeps opacity modifiers like
// `bg-slate-900/60` or `ring-accent/60` working.
const rgbVar = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;
const slateVar = (step: number) => rgbVar(`slate-${step}`);

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        slate: {
          100: slateVar(100),
          200: slateVar(200),
          300: slateVar(300),
          400: slateVar(400),
          500: slateVar(500),
          600: slateVar(600),
          700: slateVar(700),
          800: slateVar(800),
          900: slateVar(900),
          950: slateVar(950)
        },
        // The three depth levels by role: page, panels on it, pieces inside a panel.
        base: slateVar(950),
        surface: slateVar(900),
        card: slateVar(800),
        // D-571: by role, not by hue. Buttons, focus, the selected tab and links use `accent`
        // (with `accent-ink` for text on a solid accent); target markers use `target`.
        accent: { DEFAULT: rgbVar("accent"), ink: rgbVar("accent-ink") },
        target: rgbVar("target"),
        // D-568: the landing's world. Graphite ground, bone ink, and copper reserved for targets
        // and for what is moving.
        graphite: { DEFAULT: "#151413", raised: "#1f1e1c" },
        bone: { DEFAULT: "#e9e2d0", dim: "#a8a294" },
        copper: "#c98b4f"
      },
      fontFamily: {
        // Set by src/features/world/fonts.ts on the elements that render the world (landing, /learn, app).
        world: ["var(--font-archivo)", "Arial", "Helvetica", "sans-serif"]
      },
      boxShadow: {
        panel: "0 18px 70px rgb(0 0 0 / 0.28)"
      }
    }
  },
  plugins: []
};

export default config;
