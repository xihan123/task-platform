import { loadEnvFile } from 'node:process';

try {
  loadEnvFile(new URL('../.env', import.meta.url));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

// Loading in-process keeps env-file CLI flags out of Next.js child processes.
await import('next/dist/bin/next');
