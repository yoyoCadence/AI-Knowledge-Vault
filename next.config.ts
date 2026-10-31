import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // `next dev` would otherwise write its own Next.js rules into AGENTS.md, whose Next.js section is
  // maintained by hand (without the `nextjs-agent-rules` markers, which `next dev` would rewrite or,
  // with this off, delete).
  agentRules: false,
  // Native / Node-only packages are loaded at runtime instead of bundled.
  serverExternalPackages: ["sharp", "pg", "pino", "yauzl", "yazl", "unpdf"],
  async headers() {
    // Baseline hardening for the app origin. Preview responses (`/p/*`, preview host only) are
    // excluded: they set their own, stricter headers in the preview route handler, and
    // X-Frame-Options: DENY would stop the app from framing them (docs/SECURITY.md §5).
    return [
      {
        source: "/((?!p/).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // Share links (docs/SECURITY.md §7): the token is in the URL, so it is never sent on
        // as a referrer, and shared pages are never indexed. Later rules override the keys above.
        source: "/s/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
