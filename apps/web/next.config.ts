import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Server-rendered by default: the guide pages are an SEO surface. Nothing here opts
  // into static export or client-only rendering.
  poweredByHeader: false,
  // Workspace packages ship TypeScript source; Next compiles them as part of the app.
  transpilePackages: ['@gc/contracts', '@gc/i18n', '@gc/db', '@gc/config'],
  // The Postgres driver stays a Node module; bundling it breaks its sockets.
  serverExternalPackages: ['postgres'],
  // The packages use NodeNext resolution: imports name the emitted .js, sources are .ts.
  // webpack maps one to the other; Turbopack does not yet, so the scripts pass --webpack.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};

export default config;
