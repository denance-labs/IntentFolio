import type { Config } from "tailwindcss";

// The slate steps that carry depth and secondary text read CSS variables, so the app can
// retune them (globals.css, [data-app-theme]) while the landing keeps Tailwind's own values.
// The `<alpha-value>` placeholder keeps opacity modifiers like `bg-slate-900/60` working.
const slateVar = (step: number) => `rgb(var(--slate-${step}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        slate: {
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
        card: slateVar(800)
      },
      boxShadow: {
        panel: "0 18px 70px rgb(0 0 0 / 0.28)"
      }
    }
  },
  plugins: []
};

export default config;
