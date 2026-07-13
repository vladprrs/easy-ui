import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { APP_TITLE, formatDocumentTitle, useDocumentTitle } from "./useDocumentTitle";

function Titled({ title }: { title: string | null | undefined }) {
  useDocumentTitle(title);
  return null;
}

describe("formatDocumentTitle", () => {
  it("suffixes the page title with the app name", () => {
    expect(formatDocumentTitle("Прототипы")).toBe("Прототипы — easy-ui");
  });

  it("falls back to the bare app name for null/empty titles", () => {
    expect(formatDocumentTitle(null)).toBe(APP_TITLE);
    expect(formatDocumentTitle("")).toBe(APP_TITLE);
    expect(formatDocumentTitle("   ")).toBe(APP_TITLE);
  });
});

describe("useDocumentTitle", () => {
  it("sets document.title and updates it when the title changes", () => {
    const view = render(<Titled title="Галерея" />);
    expect(document.title).toBe("Галерея — easy-ui");
    view.rerender(<Titled title="Библиотека" />);
    expect(document.title).toBe("Библиотека — easy-ui");
  });

  it("uses the bare app name for an explicit null title", () => {
    render(<Titled title={null} />);
    expect(document.title).toBe(APP_TITLE);
  });

  it("skips undefined so another component keeps ownership of the title", () => {
    document.title = "Экран · Прототип — easy-ui";
    render(<Titled title={undefined} />);
    expect(document.title).toBe("Экран · Прототип — easy-ui");
  });

  it("does not restore the previous title on unmount", () => {
    const view = render(<Titled title="Отладка" />);
    view.unmount();
    expect(document.title).toBe("Отладка — easy-ui");
  });
});
