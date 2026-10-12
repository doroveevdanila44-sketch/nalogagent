import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  // Content-Security-Policy с nonce выставляет proxy.ts
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Нативные модули, драйвер БД и библиотека Excel не бандлим: их грузит Node
  serverExternalPackages: ['@node-rs/argon2', 'pg', 'bcryptjs', 'exceljs'],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Service worker не кэшируется браузером, обновления подхватываются сразу
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
  async redirects() {
    return [{ source: '/', destination: '/agent', permanent: false }];
  },
  // Иконки объявлены в метаданных, но браузер изредка просит и /favicon.ico: отдаём ту же иконку,
  // а не 404 (он попадал в консоль и делал сквозной тест консоли нестабильным)
  async rewrites() {
    return [{ source: '/favicon.ico', destination: '/icons/icon-192.png' }];
  },
};

export default nextConfig;
