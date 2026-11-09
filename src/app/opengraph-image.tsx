import { ImageResponse } from "next/og";

// In-repo generated Open Graph card for the public landing (D-001 / 7.6).
// Dark theme + EN-primary headline + allocation bar + "Incubated by Meta Pool".
// ImageResponse renders a Satori-backed subset of CSS: flexbox only (no grid),
// inline styles, explicit dimensions. Kept font-free (system default) so the
// build never depends on a remote font fetch.

export const alt = "IntentFolio — Build your portfolio with no fees, and earn spread along the way. Incubated by Meta Pool.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Allocation bar segments — mirrors the brand donut palette (BTC/ETH/NEAR + rest).
const BAR_SEGMENTS = [
  { flex: 35, color: "#22D3EE" }, // cyan
  { flex: 25, color: "#818CF8" }, // indigo
  { flex: 20, color: "#34D399" }, // emerald
  { flex: 12, color: "#FBBF24" }, // amber
  { flex: 8, color: "#475569" },  // slate
];

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0B1220",
          backgroundImage:
            "radial-gradient(ellipse at top right, rgba(34,211,238,0.14) 0%, transparent 55%)",
          padding: "72px 80px",
        }}
      >
        {/* Top: badge */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              borderRadius: 9999,
              border: "1px solid rgba(34,211,238,0.35)",
              backgroundColor: "rgba(34,211,238,0.10)",
              color: "#67E8F9",
              fontSize: 28,
              fontWeight: 600,
              padding: "10px 24px",
            }}
          >
            Meta Pool · NEAR
          </div>
        </div>

        {/* Middle: headline */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              color: "#FFFFFF",
              fontSize: 72,
              fontWeight: 700,
              letterSpacing: "-0.03em",
              lineHeight: 1.05,
            }}
          >
            Build your portfolio with no fees, and earn spread along the way.
          </div>
          <div
            style={{
              display: "flex",
              color: "#CBD5E1",
              fontSize: 38,
              marginTop: 28,
              maxWidth: 880,
            }}
          >
            Pick your mix and your portfolio moves toward it on its own.
          </div>
        </div>

        {/* Bottom: allocation bar + brand */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              width: "100%",
              height: 14,
              borderRadius: 9999,
              overflow: "hidden",
            }}
          >
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 32,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline" }}>
              <span style={{ color: "#FFFFFF", fontSize: 40, fontWeight: 700 }}>
                IntentFolio
              </span>
              <span style={{ color: "#64748B", fontSize: 30 }}>.app</span>
            </div>
            <div style={{ display: "flex", color: "#94A3B8", fontSize: 30 }}>
              Incubated by Meta Pool
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
