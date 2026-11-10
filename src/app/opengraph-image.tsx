import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

// In-repo generated Open Graph card for the public landing (D-001 / 7.6), in the landing's world
// since D-573: graphite ground, bone ink, a copper glow, Archivo for type.
// ImageResponse renders a Satori-backed subset of CSS: flexbox only (no grid), inline styles,
// explicit dimensions. Satori cannot read the variable Archivo the pages use, so two static
// instances live in `assets/fonts/` and are read from disk: the build never fetches a font.
// Attribution: see ATTRIBUTIONS.md #26

export const alt = "IntentFolio — Build your portfolio with no fees, and earn spread along the way. Incubated by Meta Pool.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The landing's tokens (tailwind.config.ts: graphite, bone, copper).
const GRAPHITE = "#151413";
const BONE = "#E9E2D0";
const BONE_DIM = "#A8A294";

// The allocation bar, in the shape the card always had (segments sized by weight, small gaps), in
// the hero donut's colors with a muted bone for the rest. A target-marker variant was tried and
// rejected by the operator as confusing (D-573).
const BAR_SEGMENTS = [
  { flex: 35, color: "#55B5E8" },
  { flex: 25, color: "#8A5CF0" },
  { flex: 20, color: "#1E9E4A" },
  { flex: 12, color: "#0E86A8" },
  { flex: 8, color: "rgba(233,226,208,0.22)" },
];

export default async function OpengraphImage() {
  const [bold, regular] = await Promise.all([
    readFile(join(process.cwd(), "assets/fonts/Archivo-SemiExpanded-Bold.ttf")),
    readFile(join(process.cwd(), "assets/fonts/Archivo-Regular.ttf")),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: GRAPHITE,
          backgroundImage: "radial-gradient(ellipse at 85% 0%, rgba(201,139,79,0.16) 0%, transparent 55%)",
          padding: "68px 80px",
          fontFamily: "Archivo",
          color: BONE,
        }}
      >
        {/* Top: badge */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              borderRadius: 9999,
              border: "1px solid rgba(233,226,208,0.22)",
              backgroundColor: "rgba(233,226,208,0.06)",
              color: BONE,
              fontSize: 26,
              padding: "10px 24px",
            }}
          >
            Meta Pool · NEAR
          </div>
        </div>

        {/* Middle: headline + sub */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {/* Two set lines: left to wrap, the last two words fell to a third line on their own. */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              fontSize: 62,
              fontWeight: 700,
              letterSpacing: "-0.015em",
              lineHeight: 1.08,
            }}
          >
            <span>Build your portfolio with no fees,</span>
            <span>and earn spread along the way.</span>
          </div>
          <div style={{ display: "flex", color: BONE_DIM, fontSize: 32, marginTop: 26, maxWidth: 880 }}>
            Pick your mix and your portfolio moves toward it on its own.
          </div>
        </div>

        {/* Bottom: allocation bar + brand */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", width: "100%", height: 14 }}>
            {BAR_SEGMENTS.map((seg, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  flex: seg.flex,
                  backgroundColor: seg.color,
                  marginRight: i < BAR_SEGMENTS.length - 1 ? 4 : 0,
                  borderRadius: 9999,
                }}
              />
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 34 }}>
            <div style={{ display: "flex", alignItems: "baseline" }}>
              <span style={{ fontSize: 40, fontWeight: 700 }}>IntentFolio</span>
              <span style={{ color: BONE_DIM, fontSize: 30 }}>.app</span>
            </div>
            <div style={{ display: "flex", color: BONE_DIM, fontSize: 28 }}>Incubated by Meta Pool</div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Archivo", data: bold, weight: 700, style: "normal" },
        { name: "Archivo", data: regular, weight: 400, style: "normal" },
      ],
    },
  );
}
