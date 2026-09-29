import { defineConfig } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT ?? '3100';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './test/browser',
  outputDir: '.test-dist/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: {
    baseURL,
    browserName: 'chromium',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    {
      name: 'mobile',
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: `node scripts/serve-static.mjs ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
