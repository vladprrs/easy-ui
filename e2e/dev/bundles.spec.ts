import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import { expect, test } from "@playwright/test";
import { bundleManifestSchema } from "../../src/bundle/schema";
import { CUSTOM_DS_COMPONENT_ID, CUSTOM_DS_PROTOTYPE_ID } from "./custom-ds.fixture";

// Bundle export/import (plan T6). Exercises the two client entry points end-to-end against the
// dev origin: the gallery "export everything" anchor (a real browser download) and the ImportDialog
// dry-run → apply round-trip. The import fixture ZIP is materialized by the exporter itself in-test
// (export of the already-provisioned custom-ds-demo prototype), never checked into the repo.

test.describe("bundle export/import from the gallery", () => {
  test.use({ acceptDownloads: true, viewport: { width: 1200, height: 800 } });

  test("bulk export downloads a valid ZIP whose manifest parses", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('main[data-gallery-ready="true"]')).toBeVisible();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Экспортировать всё" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^easy-ui-export-\d{8}\.zip$/);

    const path = await download.path();
    const bytes = new Uint8Array(await readFile(path));
    const entries = unzipSync(bytes);
    expect(Object.keys(entries)).toContain("manifest.json");
    const manifest = bundleManifestSchema.parse(JSON.parse(new TextDecoder().decode(entries["manifest.json"]!)));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.kind).toBe("bulk");
    // The bulk export closes over the custom-ds-demo prototype and its custom component.
    expect(manifest.prototypes.some((p) => p.id === CUSTOM_DS_PROTOTYPE_ID)).toBe(true);
    expect(manifest.components.some((c) => c.id === CUSTOM_DS_COMPONENT_ID)).toBe(true);
  });

  test("import dialog dry-run previews the report, then apply completes", async ({ page }) => {
    // Materialize the import fixture by exporting the published prototype closure over the API.
    const exportResponse = await page.request.get(`/api/prototypes/${CUSTOM_DS_PROTOTYPE_ID}/export?version=1`);
    expect(exportResponse.ok()).toBeTruthy();
    const zipBuffer = await exportResponse.body();

    await page.goto("/");
    await expect(page.locator('main[data-gallery-ready="true"]')).toBeVisible();
    await page.getByRole("button", { name: "Импортировать" }).click();

    const dialog = page.getByRole("dialog", { name: "Импорт бандла" });
    await expect(dialog).toBeVisible();

    // Set the ZIP directly on the (sr-only) file input — the dialog's dry-run runs on change.
    await dialog.getByLabel("ZIP-бандл для импорта").setInputFiles({
      name: `${CUSTOM_DS_PROTOTYPE_ID}.zip`,
      mimeType: "application/zip",
      buffer: zipBuffer,
    });

    // Dry-run preview: the report table renders with the prototype's closure.
    await expect(dialog.getByRole("heading", { name: "Предварительный отчёт" })).toBeVisible();
    await expect(dialog.getByText("Предварительно", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("table")).toBeVisible();
    await expect(dialog.getByRole("cell", { name: new RegExp(CUSTOM_DS_COMPONENT_ID) })).toBeVisible();

    // Apply: the same button label lives inside the dialog; the header button is out of scope.
    await dialog.getByRole("button", { name: "Импортировать" }).click();

    await expect(dialog.getByRole("heading", { name: "Отчёт об импорте" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Готово" })).toBeVisible();
    // Re-importing an already-present closure must not surface errors in the report summary.
    await expect(dialog.getByText("Ошибок: 0")).toBeVisible();
  });
});
