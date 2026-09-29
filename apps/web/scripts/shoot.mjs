// Temporary UI audit helper: logs in as seeded demo accounts and captures
// the current rendering of every surface at desktop and mobile widths.
import { mkdir, rm } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const WEB = process.env.SHOOT_WEB ?? 'http://127.0.0.1:3000';
const API = process.env.SHOOT_API ?? 'http://127.0.0.1:4000/api';
const OUT = new URL('../.shots/', import.meta.url);

const PUBLISHER = {
  email: 'publisher@demo.test',
  password: 'publisher-demo-password',
};
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? 'admin@demo.test',
  password: process.env.ADMIN_PASSWORD ?? 'admin-demo-password-1',
};

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function tasksFor(email, password) {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-CSRF-Protection': '1',
      origin: WEB,
    },
    body: JSON.stringify({ email, password }),
  });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const list = await fetch(`${API}/tasks?limit=20`, {
    headers: { cookie, origin: WEB },
  });
  const { items } = await list.json();
  return { cookie, items };
}

async function shoot(page, name, url) {
  await page.goto(`${WEB}${url}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.screenshot({
    path: new URL(`${name}.png`, OUT).pathname.replace(/^\//, ''),
    fullPage: true,
  });
  return page.title();
}

async function session(browser, viewport, creds) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.name === 'mobile',
    hasTouch: viewport.name === 'mobile',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  if (creds) {
    await page.goto(WEB, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('邮箱').fill(creds.email);
    await page.getByLabel('密码', { exact: true }).fill(creds.password);
    await page.getByRole('button', { name: /登录|创建账户/ }).click();
    await page.waitForTimeout(1200);
  }
  return { context, page };
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const pub = await tasksFor(PUBLISHER.email, PUBLISHER.password);
const byStatus = (s) => pub.items.find((t) => t.status === s)?.id;
const inProgress = byStatus('IN_PROGRESS');
const pending = byStatus('PENDING_REVIEW');
const open = byStatus('OPEN');
console.log(
  'tasks:',
  pub.items.map((t) => `${t.status}:${t.id.slice(0, 8)}`).join(' '),
);

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});

for (const vp of VIEWPORTS) {
  // Anonymous surfaces.
  {
    const { context, page } = await session(browser, vp, null);
    await shoot(page, `${vp.name}-01-home-anon`, '/');
    await shoot(page, `${vp.name}-02-tasks-anon`, '/tasks');
    if (open)
      await shoot(
        page,
        `${vp.name}-03-task-detail-anon`,
        `/tasks/detail?id=${open}`,
      );
    await context.close();
  }
  // Publisher surfaces.
  {
    const { context, page } = await session(browser, vp, PUBLISHER);
    await shoot(page, `${vp.name}-04-home-user`, '/');
    await shoot(page, `${vp.name}-05-tasks-user`, '/tasks');
    await shoot(page, `${vp.name}-06-task-new`, '/tasks/new');
    if (pending)
      await shoot(
        page,
        `${vp.name}-07-detail-pending`,
        `/tasks/detail?id=${pending}`,
      );
    if (inProgress) {
      await shoot(
        page,
        `${vp.name}-08-detail-in-progress`,
        `/tasks/detail?id=${inProgress}`,
      );
      await shoot(
        page,
        `${vp.name}-09-chat`,
        `/tasks/detail?id=${inProgress}#discussion`,
      );
    }
    await context.close();
  }
  // Admin console.
  {
    const { context, page } = await session(browser, vp, ADMIN);
    await shoot(page, `${vp.name}-10-admin-dashboard`, '/admin');
    await shoot(page, `${vp.name}-11-admin-tasks`, '/admin/tasks');
    await shoot(page, `${vp.name}-12-admin-users`, '/admin/users');
    await shoot(page, `${vp.name}-13-admin-moderations`, '/admin/moderations');
    await shoot(page, `${vp.name}-14-admin-ai`, '/admin/ai');
    if (inProgress)
      await shoot(
        page,
        `${vp.name}-15-admin-detail`,
        `/admin/tasks/detail?id=${inProgress}`,
      );
    await context.close();
  }
  console.log(`${vp.name} done`);
}

await browser.close();
