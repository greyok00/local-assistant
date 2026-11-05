import { test, expect } from '@playwright/test';

test('ingest runs and offers both artifact files', async ({ page }) => {
  await page.goto('/product/src/dashboard.html?fixture=1');
  await page.locator('#la-url').fill('/product/tests/fixtures/site/');
  await page.locator('#la-start').click();
  await expect(page.locator('#la-report')).toContainText('2 pages', { timeout: 20000 });
  await expect(page.locator('#la-download .la-file')).toHaveCount(2);
});

test('a failed page is listed, not silently dropped', async ({ page }) => {
  await page.goto('/product/src/dashboard.html?fixture=1');
  await page.locator('#la-url').fill('/product/tests/fixtures/site/');
  await page.route('**/a.html', route => route.fulfill({ status: 500, body: 'boom' }));
  await page.locator('#la-start').click();
  await expect(page.locator('#la-report')).toContainText('a.html');
  await expect(page.locator('#la-report')).toContainText('HTTP 500');
});

test('fixture mode is enabled only on local hosts', async ({ page }) => {
  await page.goto('/product/src/dashboard.html');
  const flags = await page.evaluate(async () => {
    const { isFixtureMode } = await import('/product/src/dashboard.js');
    return {
      local: isFixtureMode('?fixture=1', '127.0.0.1'),
      remote: isFixtureMode('?fixture=1', 'example.com'),
      disabled: isFixtureMode('?fixture=0', '127.0.0.1')
    };
  });
  expect(flags).toEqual({ local: true, remote: false, disabled: false });
});

test('a WordPress save failure keeps the run report and offers a retry', async ({ page }) => {
  await page.addInitScript(() => {
    globalThis.wpAssistant = { ajaxUrl: '/wp-admin/admin-ajax.php', nonce: 'n1', siteName: 'Fixture Site' };
  });
  await page.route('**/wp-admin/admin-ajax.php', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '0' }));
  await page.goto('/product/src/dashboard.html?fixture=1');
  await page.locator('#la-url').fill('/product/tests/fixtures/site/');
  await page.locator('#la-start').click();
  await expect(page.locator('#la-report')).toContainText('2 pages', { timeout: 20000 });
  await expect(page.locator('#la-report')).toContainText('Save failed: unexpected response: 0');
  await expect(page.locator('#la-save')).toBeVisible();
});
