#!/usr/bin/env node
// Клик-проверка YP-прототипа в плеере (headless chromium из devDeps репо).
// usage: node interact.mjs <prototypeId> <outDir>
// Логинится кредами EASYUI_USERNAME/EASYUI_PASSWORD, открывает /p/<id>,
// кликает по селектору из CLICKS и снимает PNG после каждого шага.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createEasyUiClient } from "../../../scripts/easyui-auth.mjs";

const API = (process.env.EASYUI_API ?? "https://easy-ui.pay-offline.ru/api").replace(/\/$/, "");
const [id, outDir = "./interact-shots"] = process.argv.slice(2);
if (!id) {
  console.error("usage: interact.mjs <prototypeId> [outDir]");
  process.exit(2);
}

// Шаги демо yp-checkout-demo; для другого прототипа подставить свои селекторы.
const CLICKS = [
  { label: "select-sbp", selector: 'text=СБП' },
  { label: "press-cta", selector: 'button:has-text("Оплатить")' },
];

const { chromium } = await import("playwright");
const client = createEasyUiClient({ apiBase: API });
await client.login();
const origin = API.replace(/\/api$/, "");
const [name, value] = client.cookieHeader.split("=", 2);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addCookies([{ name, value, url: origin }]);
const page = await context.newPage();
await mkdir(resolve(outDir), { recursive: true });

await page.goto(`${origin}/p/${id}`, { waitUntil: "networkidle" });
await page.screenshot({ path: resolve(outDir, "0-initial.png") });
let step = 1;
for (const { label, selector } of CLICKS) {
  await page.click(selector);
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(outDir, `${step}-${label}.png`) });
  console.log(`clicked ${selector} -> ${step}-${label}.png`);
  step += 1;
}
await browser.close();
