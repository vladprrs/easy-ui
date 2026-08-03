import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Composition workbench против реального Bun preview-сервера (план 2026-08-03 §5 W9).
 *
 * Проверяется путь агента целиком: **поиск → вердикт → создание композиции → повторный поиск**.
 * Ключевая находка ревью (R1-M9) в том, что до W9 корпус матчера собирал только компоненты,
 * поэтому дубль композиции не детектировался: тест ловит именно это — первый поиск исходов
 * дубля не даёт, а после создания та же структура тела опознаётся как существующая композиция.
 *
 * Исход **рекомендательный**: сервер отвечает 200 и в обоих случаях, гейт переиспользования на
 * композиции не распространяется. Тест обязан фиксировать это, чтобы включение enforce было
 * осознанным изменением, а не незамеченным побочным эффектом.
 */

const DS_ID = "e2e-workbench";
const COMPOSITION_ID = "e2e-workbench-order-row";
const INTENT = "Строка заказа с иконкой, названием и кнопкой оплаты";

/** Тело из host-примитивов: публикации компонентов ДС для этого сценария не нужны. */
const body = (icon: string, label: string) => ({
  root: "root",
  elements: {
    root: { type: "Overlay", props: { className: "order-row" }, children: ["icon", "action"] },
    icon: { type: "Image", props: { src: icon } },
    action: { type: "Hotspot", props: { label } },
  },
});

const doc = (name: string, description: string, icon: string, label: string) => ({
  version: 2, name, description, atomicLevel: "molecule",
  params: { title: { type: "string", required: true } }, slots: [],
  spec: body(icon, label),
});

interface WorkbenchResult {
  outcome: "build-composition" | "extend-component" | "new-ownership-component";
  explanation: string;
  analyzerVerdict?: string;
  matches: { kind: string; id: string; score: number; blocking: boolean; why: string }[];
  candidates: { kind: string; id: string }[];
  dependencyImpact: { components: unknown[]; compositions: unknown[]; unknownTypes: string[] };
}

async function search(request: APIRequestContext, compositionDoc: Record<string, unknown>, id: string): Promise<WorkbenchResult> {
  const response = await request.post("/api/catalog/candidates", {
    data: { designSystem: DS_ID, intent: INTENT, limit: 8, proposed: { kind: "composition", id, compositionDoc } },
  });
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as WorkbenchResult;
}

test("composition workbench: поиск → вердикт → создание композиции → дубль детектируется", async ({ request }) => {
  const system = await request.post("/api/design-systems", {
    data: { id: DS_ID, name: "E2E Workbench", description: "Design system for the composition workbench e2e" },
  });
  expect([201, 409], await system.text()).toContain(system.status());

  // 1. Каталог пуст: исход — «собирать», дубля нет, анализатор подтверждает выразимость.
  const first = await search(request, doc("OrderRow", "Строка заказа с иконкой и кнопкой оплаты", "icon.png", "Оплатить"), COMPOSITION_ID);
  expect(first.outcome).toBe("build-composition");
  expect(first.analyzerVerdict).toBe("composition");
  expect(first.matches.filter((match) => match.kind === "composition")).toEqual([]);
  expect(first.dependencyImpact.unknownTypes).toEqual([]);

  // 2. Создание композиции по вердикту.
  const created = await request.post("/api/compositions", {
    data: {
      id: COMPOSITION_ID, designSystem: DS_ID, message: "workbench e2e",
      doc: doc("OrderRow", "Строка заказа с иконкой и кнопкой оплаты", "icon.png", "Оплатить"),
    },
  });
  expect([201, 409], await created.text()).toContain(created.status());

  // 3. Тот же скелет с другими значениями props и другим именем: значения в сигнатуру не входят,
  // поэтому дубль обязан найтись — это и есть закрытая в W9 дыра R1-M9.
  const second = await search(
    request,
    doc("OrderLine", "Ещё одна строка заказа с иконкой и кнопкой оплаты", "other.png", "Заплатить"),
    "e2e-workbench-order-line",
  );
  expect(second.outcome).toBe("build-composition");
  expect(second.explanation).toContain(COMPOSITION_ID);
  const duplicate = second.matches.find((match) => match.id === COMPOSITION_ID);
  expect(duplicate, JSON.stringify(second.matches)).toBeTruthy();
  expect(duplicate!).toMatchObject({ kind: "composition", blocking: true });
  expect(duplicate!.why).toContain("identical composition body signature");
  // Композиция видна и в общей выдаче кандидатов, а не только в `matches`.
  expect(second.candidates.some((candidate) => candidate.kind === "composition" && candidate.id === COMPOSITION_ID)).toBe(true);
});
