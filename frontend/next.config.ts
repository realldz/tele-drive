import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    resolveAlias: {
      // pdfjs-dist optionally requires 'canvas' which doesn't exist in the browser
      canvas: { browser: "" },
    },
  },
  webpack: (config) => {
    // Same alias for production builds using webpack
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
