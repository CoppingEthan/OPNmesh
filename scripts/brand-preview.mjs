#!/usr/bin/env node
/**
 * Render the logo concepts in branding/concepts/*.svg to PNG with Playwright:
 * one light and one dark card per concept, plus a contact sheet of them all.
 *
 *   node scripts/brand-preview.mjs
 */
import { chromium } from "playwright";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const dir = resolve("branding/concepts");
const out = join(dir, "preview");
mkdirSync(out, { recursive: true });

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".svg"))
  .sort();
const INK = "#16211d";

const cards = files
  .map((f) => {
    const svg = readFileSync(join(dir, f), "utf8");
    const dark = svg.replaceAll(INK, "#f4f7f5");
    const name = basename(f, ".svg");
    const title = svg.match(/<!--\s*(Concept[^—]*—[^:]*):/)?.[1] ?? name;
    // The O on its own: crop the lockup's viewBox to the icon so the text falls away.
    const icon = svg.replace(/viewBox="0 0 560 130" width="560" height="130"/, 'viewBox="22 24 84 84" width="84" height="84"');
    const iconDark = icon.replaceAll(INK, "#f4f7f5");
    const sizes = [64, 32, 16];
    return `
      <figure data-name="${name}">
        <figcaption>${title.trim()}</figcaption>
        <div class="row">
          <div class="card light" data-shot="${name}-light">${svg}</div>
          <div class="card dark" data-shot="${name}-dark">${dark}</div>
          <div class="card icons" data-shot="${name}-icons">
            <div class="light">${sizes.map((s) => `<span style="width:${s}px;height:${s}px">${icon}</span>`).join("")}</div>
            <div class="dark">${sizes.map((s) => `<span style="width:${s}px;height:${s}px">${iconDark}</span>`).join("")}</div>
          </div>
        </div>
      </figure>`;
  })
  .join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; padding: 32px; background: #e9ebef; font-family: "Segoe UI", system-ui, sans-serif; color: #333; }
  h1 { font-size: 18px; margin: 0 0 20px; font-weight: 600; }
  figure { margin: 0 0 22px; }
  figcaption { font-size: 13px; color: #555; margin-bottom: 8px; }
  .row { display: flex; gap: 16px; }
  .card { border-radius: 16px; padding: 22px 28px; width: 560px; box-shadow: 0 6px 24px -12px rgba(0,0,0,.25); }
  .card.light { background: #ffffff; }
  .card.dark { background: #0f1512; }
  .card > svg { width: 560px; height: 130px; display: block; }
  .card.icons { width: 200px; padding: 0; overflow: hidden; display: flex; flex-direction: column; }
  .card.icons > div { flex: 1; display: flex; align-items: center; justify-content: center; gap: 16px; padding: 12px; }
  .card.icons > .light { background: #ffffff; }
  .card.icons > .dark { background: #0f1512; }
  .card.icons span { display: inline-block; }
  .card.icons svg { width: 100%; height: 100%; display: block; }
</style></head><body>
  <h1>OPNmesh logo concepts</h1>
  ${cards}
</body></html>`;
const page = join(out, "sheet.html");
writeFileSync(page, html);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1460, height: 900 }, deviceScaleFactor: 2 });
const tab = await ctx.newPage();
await tab.goto("file:///" + page.replace(/\\/g, "/"));
await tab.waitForTimeout(300);
await tab.screenshot({ path: join(out, "sheet.png"), fullPage: true });
console.log("saved preview/sheet.png");
for (const el of await tab.locator("[data-shot]").all()) {
  const name = await el.getAttribute("data-shot");
  await el.screenshot({ path: join(out, `${name}.png`) });
  console.log(`saved preview/${name}.png`);
}
await browser.close();
