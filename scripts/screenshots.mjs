#!/usr/bin/env node
/**
 * Screenshot every main page of a running controller with Playwright, for a
 * visual check. Defaults to the simulation controller.
 *
 *   node scripts/screenshots.mjs [baseUrl] [email] [password] [outDir]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = process.argv[2] ?? "http://127.0.0.1:18080";
const email = process.argv[3] ?? "admin@example.com";
const password = process.argv[4] ?? "simulation password 1";
const out = process.argv[5] ?? "screenshots";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const scheme of ["dark"]) {
  // Tall viewport: the wallpaper is fixed to the viewport, so a full-page
  // capture with a short one would show it stopping part-way down.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1700 }, colorScheme: scheme, deviceScaleFactor: 1, locale: "en-GB", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  const login = await page.request.post(`${base}/api/admin/login`, { data: { email, password } });
  if (!login.ok()) throw new Error(`login failed: ${login.status()} ${await login.text()}`);
  const state = await (await page.request.get(`${base}/api/admin/state`)).json();
  const siteId = state.sites[0]?.id;
  const clientId = state.clients[0]?.id;
  // Ask the first site's gateway to run its health checks so the panel has
  // real results to show; the light pass triggers, the dark pass reuses them.
  if (siteId) {
    await page.request.post(`${base}/api/admin/sites/${siteId}/diagnostics`, { data: {} });
    await page.waitForTimeout(9000);
  }
  const pages = ["/", "/sites", siteId && `/sites/${siteId}`, "/clients", clientId && `/clients/${clientId}`, "/traffic", "/events", "/settings"].filter(Boolean);
  for (const p of pages) {
    await page.goto(base + p, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const name = p === "/" ? "overview" : p.replace(/^\//, "").replace(/\//g, "-");
    await page.screenshot({ path: join(out, `${name}-${scheme}.png`), fullPage: true });
    console.log(`saved ${name}-${scheme}.png`);
    if (p === "/") {
      // The overview graph in a history range, too.
      const btn = page.getByRole("button", { name: "1 hour", exact: true });
      if (await btn.count()) {
        await btn.click();
        await page.waitForTimeout(2000);
        await page.screenshot({ path: join(out, `overview-1h-${scheme}.png`), fullPage: true });
        console.log(`saved overview-1h-${scheme}.png`);
      }
    }
  }
  await ctx.close();
}
await browser.close();
