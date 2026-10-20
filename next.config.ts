import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // Native / Node-only packages are loaded at runtime instead of bundled.
  serverExternalPackages: ["sharp", "pg", "pino", "yauzl", "yazl", "unpdf"],
  async headers() {
    // Baseline hardening for the app origin. Preview-origin responses set their own,
    // stricter headers in the preview route handler (docs/SECURITY.md §5).
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
