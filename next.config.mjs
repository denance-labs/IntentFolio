/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  // The TonConnect manifest's CORS header moved into the route that now generates it
  // (`src/app/tonconnect-manifest.json/route.ts`, D-245) — it is set next to the response it
  // belongs to instead of matched by path from here.
  // D-515: the portfolio's History tab became Activity; old links and bookmarks keep working.
  async redirects() {
    return [
      { source: "/dashboard/history", destination: "/dashboard/activity", permanent: true },
      { source: "/mock-dashboard/history", destination: "/mock-dashboard/activity", permanent: true },
      // The bare dashboard opens on Overview. Here, not as a `redirect()` in the index page: the
      // app booted from that redirect crashed (React #310 in Next's Router) on the first
      // `router.push` of a portfolio switch (D-527). `?entry=1` tells the shell the user is
      // entering, not reloading, so it opens on My Account (022-C, D-544; `ENTRY_PARAM` there).
      { source: "/dashboard", destination: "/dashboard/overview?entry=1", permanent: false },
      { source: "/mock-dashboard", destination: "/mock-dashboard/overview?entry=1", permanent: false },
    ];
  },
  webpack(config) {
    // @reown/appkit-adapter-wagmi bundles @wagmi/connectors which re-exports
    // tempoWallet from '@wagmi/core/tempo' — a path not exported by the
    // installed @wagmi/core version. Stub it out so the client bundle resolves.
    config.resolve.alias["@wagmi/core/tempo"] = false;
    return config;
  },
};

export default nextConfig;
