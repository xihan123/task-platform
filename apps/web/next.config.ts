import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_OUTPUT_DIR || '.next',
  output: 'export',
  poweredByHeader: false,
  devIndicators: false,
};

export default nextConfig;
