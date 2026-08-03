import { describe, expect, test } from "bun:test";
import { sourceShingles } from "./fingerprint";
import { CORPUS, FIXTURE_IDF, PAY_BUTTON_SCHEMA, activeCandidate, draftCandidate, payButton } from "./fixtures/corpus";
import { PAY_BUTTON_SOURCE, PROMO_CARD_SOURCE, RATING_STARS_SOURCE, RENAMED_PAY_BUTTON_SOURCE } from "./fixtures/sources";
import { matchCandidates, score, type CorpusCandidate, type ProposedArtifact } from "./matcher";
import { CALIBRATED_POLICY, SPEC_DEFAULT_POLICY, totalWeight, type MatchPolicy } from "./policy";

// Политика инъектируется параметром (план D7): здесь она берётся из `policy.ts` только как
// стартовая точка. Тесты, зависящие от конкретного порога, задают свою политику явно —
// калибровка T0 переопределит значения, и эти тесты обязаны это пережить.
const policy = SPEC_DEFAULT_POLICY;
const withThresholds = (blocking: number, review: number): MatchPolicy => ({ ...policy, blockingThreshold: blocking, reviewThreshold: review });
const idf = FIXTURE_IDF;
const options = { idf };

const proposedPayButtonClone: ProposedArtifact = {
  kind: "component",
  designSystem: "yandex-pay",
  id: "yp-payment-button",
  name: "YpPaymentButton",
  intent: "кнопка оплаты Яндекс Пэй на экране чекаута",
  description: "Кнопка оплаты Яндекс Пэй",
  atomicLevel: "molecule",
  scope: "primitive",
  meta: { propsJsonSchema: PAY_BUTTON_SCHEMA, events: ["press"], slots: [] },
  source: PAY_BUTTON_SOURCE,
};

const renamedCopyPaste: ProposedArtifact = {
  ...proposedPayButtonClone,
  id: "yp-checkout-button",
  name: "YpCheckoutButton",
  intent: "кнопка перехода к оплате в чекауте",
  description: "Кнопка перехода к оплате",
  source: RENAMED_PAY_BUTTON_SOURCE,
};

describe("matchCandidates — сигналы блокировки", () => {
  test("пересечение канонической роли блокирует независимо от score", () => {
    const proposed: ProposedArtifact = {
      kind: "component",
      designSystem: "yandex-pay",
      name: "PaymentDone",
      intent: "экран подтверждения платежа",
      description: "Подтверждение платежа",
      canonicalFor: ["payment-success"],
      meta: { propsJsonSchema: { type: "object", properties: { sum: { type: "string" } }, required: ["sum"] }, events: [], slots: [] },
      source: "export default function PaymentDone() { return null; }",
    };
    const result = matchCandidates(CORPUS, proposed, policy, options);
    const success = result.blocking.find((candidate) => candidate.id === "yp-payment-success");
    expect(success?.blocking).toBe(true);
    expect(success?.score).toBeLessThan(policy.blockingThreshold);
    expect(success?.reasons).toContain("same canonical role: payment-success");
  });

  test("точное совпадение отпечатков схемы и исходника блокирует", () => {
    const result = matchCandidates(CORPUS, proposedPayButtonClone, policy, options);
    const [top] = result.candidates;
    expect(top?.id).toBe("yp-pay-button");
    expect(top?.blocking).toBe(true);
    expect(top?.score).toBeGreaterThanOrEqual(policy.blockingThreshold);
    expect(top?.reasons).toContain("same props/events/slots signature");
    expect(top?.reasons).toContain("100% normalized source structure");
    expect(result.blocking.map((candidate) => candidate.id)).toEqual(["yp-pay-button"]);
  });

  test("переименованная копипаста: сигнал исходника держится, блокировка — по структурному отпечатку", () => {
    const result = matchCandidates(CORPUS, renamedCopyPaste, policy, options);
    const top = result.candidates[0];
    expect(top?.id).toBe("yp-pay-button");
    expect(top?.signals.source).toBeGreaterThan(0.8);
    expect(top?.reasons.some((reason) => /normalized source structure$/.test(reason))).toBe(true);
    expect(top?.blocking).toBe(true);
  });

  test("копипаста с изменёнными пропами (отпечатки расходятся) остаётся review-кандидатом", () => {
    // Честная граница из плана §1.1 (B3): под стартовыми весами такая пара набирает ~0.7 и
    // блокируется только после калибровки T0. Тест фиксирует именно review-полосу, а не
    // «блокируется» — иначе он врал бы про возможности гейта до калибровки.
    const proposed: ProposedArtifact = {
      ...renamedCopyPaste,
      meta: { propsJsonSchema: { type: "object", properties: { label: { type: "string" }, disabled: { type: "boolean" }, loading: { type: "boolean" } }, required: ["label"] }, events: ["press"], slots: [] },
    };
    const [top] = matchCandidates(CORPUS, proposed, policy, options).candidates;
    expect(top?.id).toBe("yp-pay-button");
    expect(top?.signals.source).toBeGreaterThan(0.8);
    expect(top?.score).toBeGreaterThanOrEqual(policy.reviewThreshold);
    expect(top?.score).toBeLessThan(policy.blockingThreshold);
    expect(top?.blocking).toBe(false);
  });

  test("похожее имя при несовместимых props не дотягивает до review", () => {
    const proposed: ProposedArtifact = {
      kind: "component",
      designSystem: "yandex-pay",
      name: "YpPayLinkButton",
      intent: "ссылка на страницу оплаты",
      description: "Ссылка на внешнюю страницу оплаты",
      atomicLevel: "molecule",
      scope: "primitive",
      meta: { propsJsonSchema: { type: "object", properties: { href: { type: "string" }, text: { type: "string" } }, required: ["href", "text"] }, events: [], slots: [] },
      source: PROMO_CARD_SOURCE,
    };
    const breakdown = score(payButton, proposed, policy, idf);
    expect(breakdown.signals.name).toBeGreaterThanOrEqual(0.6);
    expect(breakdown.signals.props).toBe(0);
    expect(breakdown.score).toBeLessThan(policy.reviewThreshold);
    expect(matchCandidates(CORPUS, proposed, policy, options).blocking).toEqual([]);
  });

  test("одинаковая структура в другой дизайн-системе кандидатом не является", () => {
    const result = matchCandidates(CORPUS, proposedPayButtonClone, policy, { ...options, limit: 20 });
    expect(result.candidates.some((candidate) => candidate.designSystem !== "yandex-pay")).toBe(false);
    expect(result.candidates.some((candidate) => candidate.id === "sh-pay-button")).toBe(false);
    // Тот же близнец в своей системе — блокирующий кандидат.
    const inShadcn = matchCandidates(CORPUS, { ...proposedPayButtonClone, designSystem: "shadcn" }, policy, options);
    expect(inShadcn.blocking.map((candidate) => candidate.id)).toEqual(["sh-pay-button"]);
  });
});

describe("matchCandidates — deprecated и recommendable", () => {
  const proposedRating: ProposedArtifact = {
    kind: "component",
    designSystem: "yandex-pay",
    name: "UiRatingStarsNew",
    intent: "рейтинг звёздами в карточке мерчанта",
    description: "Рейтинг звёздами",
    atomicLevel: "atom",
    scope: "primitive",
    meta: { propsJsonSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] }, events: [], slots: [] },
    source: RATING_STARS_SOURCE,
  };

  test("deprecated с активной заменой в корпусе не блокирует и не рекомендуется", () => {
    const result = matchCandidates(CORPUS, proposedRating, policy, options);
    const deprecated = result.candidates.find((candidate) => candidate.id === "ui-rating-stars");
    expect(deprecated?.score).toBeGreaterThanOrEqual(policy.blockingThreshold);
    expect(deprecated?.blocking).toBe(false);
    expect(deprecated?.recommendable).toBe(false);
    expect(deprecated?.reasons).toContain("deprecated: use UiStars instead");
    expect(result.blocking.map((candidate) => candidate.id)).not.toContain("ui-rating-stars");
  });

  test("замена ищется по полному корпусу, а не по усечённой выдаче", () => {
    // limit = 1 отрезает `ui-stars` от ответа; демотирование deprecated обязано выжить.
    const result = matchCandidates(CORPUS, proposedRating, policy, { ...options, limit: 1 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.id).toBe("ui-rating-stars");
    expect(result.candidates[0]?.blocking).toBe(false);
  });

  test("deprecated без активной замены в корпусе продолжает блокировать", () => {
    const withoutReplacement = CORPUS.filter((candidate) => candidate.id !== "ui-stars");
    const result = matchCandidates(withoutReplacement, proposedRating, policy, options);
    const deprecated = result.blocking.find((candidate) => candidate.id === "ui-rating-stars");
    expect(deprecated?.blocking).toBe(true);
    expect(deprecated?.recommendable).toBe(false);
    expect(deprecated?.reasons).toContain("deprecated without an active replacement");
  });
});

describe("matchCandidates — инвариант неприменимого сигнала", () => {
  test("оба множества пусты: отсутствие событий и слотов не даёт даровых 0.15", () => {
    const noIo = activeCandidate({
      id: "yp-static-badge", name: "YpStaticBadge", description: "Статичный бейдж",
      meta: { propsJsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, events: [], slots: [] },
      shingles: sourceShingles("export default function YpStaticBadge({ text }) { return <span>{text}</span>; }"),
    });
    const proposed: ProposedArtifact = {
      kind: "component", designSystem: "yandex-pay", name: "YpNoticeBadge", intent: "бейдж-уведомление",
      description: "Статичный бейдж", meta: { propsJsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, events: [], slots: [] },
      source: "export default function YpNoticeBadge({ text }) { return <span>{text}</span>; }",
    };
    const breakdown = score(noIo, proposed, policy, idf);
    expect(breakdown.signals.io).toBeUndefined();
    expect(breakdown.signals.levelScope).toBeUndefined();
    expect(breakdown.signals.appliedWeight).toBeCloseTo(policy.weights.props + policy.weights.source + policy.weights.name + policy.weights.description, 10);
  });

  test("драфт vs активная публикация: перенормировка на двух сигналах", () => {
    // У драфта нет `definition_meta`: props, io, atomicLevel, scope и description неприменимы —
    // 0.65 весового бюджета из 1.00. Без перенормировки score схлопывается до ~0.35.
    const draft = draftCandidate("yp-payment-button-copy", "YpPaymentButtonCopy", PAY_BUTTON_SOURCE);
    const breakdown = score(draft, proposedPayButtonClone, policy, idf);
    expect(breakdown.signals).toMatchObject({ source: 1, appliedWeight: policy.weights.source + policy.weights.name });
    expect(breakdown.signals.props).toBeUndefined();
    expect(breakdown.signals.io).toBeUndefined();
    expect(breakdown.signals.description).toBeUndefined();
    expect(breakdown.signals.levelScope).toBeUndefined();

    const withoutRenormalization = policy.weights.source * 1 + policy.weights.name * (breakdown.signals.name ?? 0);
    expect(withoutRenormalization).toBeLessThan(policy.reviewThreshold);
    expect(breakdown.score).toBeGreaterThan(0.85);
  });

  test("байт-идентичный драфт-дубликат блокируется", () => {
    const draft = draftCandidate("yp-payment-button-copy", "YpPaymentButtonCopy", PAY_BUTTON_SOURCE);
    const result = matchCandidates([draft], proposedPayButtonClone, policy, options);
    const [top] = result.candidates;
    expect(top?.blocking).toBe(true);
    expect(top?.draft).toBe(true);
    expect(top?.reasons).toContain("100% normalized source structure");
    expect(result.blocking).toHaveLength(1);
  });

  test("ни одного применимого сигнала — score 0, а не единица по умолчанию", () => {
    const bare = activeCandidate({ id: "yp-bare", name: "", description: "" });
    expect(score(bare, { kind: "component", designSystem: "yandex-pay" }, policy, idf)).toMatchObject({ score: 0, signals: { appliedWeight: 0 } });
  });
});

describe("matchCandidates — RU/EN описания и порядок", () => {
  const englishTwin = activeCandidate({
    id: "yp-pay-button-en", name: "PaymentButton", description: "Payment button with loading state",
    atomicLevel: "molecule", scope: "primitive",
    meta: { propsJsonSchema: PAY_BUTTON_SCHEMA, events: ["press"], slots: [] },
    shingles: sourceShingles(PAY_BUTTON_SOURCE),
  });

  test("описание работает и на кириллице, и на латинице", () => {
    const russian = score(payButton, { kind: "component", designSystem: "yandex-pay", name: "X", intent: "кнопка оплаты Яндекс Пэй" }, policy, idf);
    const english = score(englishTwin, { kind: "component", designSystem: "yandex-pay", name: "X", intent: "payment button with loading state" }, policy, idf);
    expect(russian.signals.description).toBe(1);
    expect(english.signals.description).toBe(1);
    // Кросс-язычное пересечение по токенам невозможно — сигнал честно падает в ноль.
    expect(score(englishTwin, { kind: "component", designSystem: "yandex-pay", name: "X", intent: "кнопка оплаты Яндекс Пэй" }, policy, idf).signals.description).toBe(0);
  });

  test("равный score упорядочивается по id по возрастанию, порядок стабилен между прогонами", () => {
    const twins: CorpusCandidate[] = ["yp-twin-c", "yp-twin-a", "yp-twin-b"].map((id) =>
      activeCandidate({ id, name: "YpTwin", description: "Кнопка оплаты Яндекс Пэй", atomicLevel: "molecule", scope: "primitive", meta: { propsJsonSchema: PAY_BUTTON_SCHEMA, events: ["press"], slots: [] }, shingles: sourceShingles(PAY_BUTTON_SOURCE) }));
    const first = matchCandidates(twins, proposedPayButtonClone, policy, options);
    const second = matchCandidates([...twins].reverse(), proposedPayButtonClone, policy, options);
    expect(first.candidates.map((candidate) => candidate.id)).toEqual(["yp-twin-a", "yp-twin-b", "yp-twin-c"]);
    expect(second.candidates).toEqual(first.candidates);
    expect(new Set(first.candidates.map((candidate) => candidate.score)).size).toBe(1);
  });

  test("score округляется до 4 знаков до сортировки", () => {
    for (const candidate of matchCandidates(CORPUS, renamedCopyPaste, policy, { ...options, limit: 20 }).candidates) {
      expect(candidate.score).toBe(Math.round(candidate.score * 10_000) / 10_000);
    }
  });
});

describe("matchCandidates — пороги, выдача и дельта пропов", () => {
  // Кандидат, у которого применим ровно один сигнал (имя): score равен Jaccard токенов имени,
  // поэтому границы порогов проверяются точным числом, а не «примерно».
  const nameOnly = (id: string, name: string): CorpusCandidate => activeCandidate({ id, name });
  const nameProposal: ProposedArtifact = { kind: "component", designSystem: "yandex-pay", name: "AlphaBetaGammaDeltaEpsilon" };

  test("границы 0.65 и 0.82 включающие", () => {
    const four = nameOnly("cand-4", "AlphaBetaGammaDelta"); // 4/5 = 0.8
    const three = nameOnly("cand-3", "AlphaBetaGamma"); // 3/5 = 0.6
    const scored = matchCandidates([four, three], nameProposal, policy, { ...options, limit: 20 });
    expect(scored.candidates.map((candidate) => candidate.score)).toEqual([0.8, 0.6]);
    expect(scored.blocking).toEqual([]);

    // Порог включающий, но применяется только при структурных уликах (см. тест ниже): у
    // кандидата по одному имени их нет, поэтому 0.8 ≥ 0.8 всё равно не блокирует.
    expect(matchCandidates([four], nameProposal, withThresholds(0.8, 0.65), options).blocking).toHaveLength(0);
    expect(matchCandidates([three], nameProposal, withThresholds(0.82, 0.6), options).candidates[0]?.score).toBe(0.6);

    // Тот же кандидат с применимым структурным сигналом: граница включающая (0.8 ≥ 0.8),
    // а на 0.8001 — уже нет.
    const shared = "const Widget = () => <div className=\"alpha\">beta</div>;";
    const structural = nameOnly("cand-src", "AlphaBetaGammaDelta");
    const withSource: CorpusCandidate = { ...structural, shingles: sourceShingles(shared) };
    const sourceProposal: ProposedArtifact = { ...nameProposal, source: shared };
    const exact = matchCandidates([withSource], sourceProposal, withThresholds(0.8, 0.65), options);
    expect([exact.blocking.length, exact.candidates[0]!.score >= 0.8]).toEqual([1, true]);
    expect(matchCandidates([withSource], sourceProposal, withThresholds(1.0001, 0.65), options).blocking).toHaveLength(0);
  });

  test("порог не срабатывает без структурных улик: описание в одиночку не блокирует", () => {
    // При поиске по одному `intent` перенормировка схлопывает знаменатель до единственного
    // сигнала, и дословное совпадение описания даёт score выше порога при весе описания 0.05
    // из 1.00. Blocking обязан опираться на props/io/source (либо на роль/отпечаток), иначе
    // discovery-поиск объявлял бы «создавать нельзя» без единой структурной улики.
    const text = "разделитель между блоками списка";
    const candidate = activeCandidate({ id: "yp-separator", name: "YpSeparator", description: text });
    const intentOnly: ProposedArtifact = { kind: "component", designSystem: "yandex-pay", intent: text };
    const result = matchCandidates([candidate], intentOnly, policy, options);
    expect(result.candidates[0]!.score).toBeGreaterThanOrEqual(policy.blockingThreshold);
    expect([result.candidates[0]!.blocking, result.blocking.length]).toEqual([false, 0]);
  });

  test("blocking-кандидат с низким score попадает в выдачу раньше более похожего непроходного", () => {
    // Роль блокирует независимо от score — усечение по limit не имеет права его выкинуть.
    const proposed: ProposedArtifact = {
      kind: "component", designSystem: "yandex-pay", name: "YpPaymentSuccessScreen",
      intent: "экран успешной оплаты", canonicalFor: ["payment-success"],
    };
    const result = matchCandidates(CORPUS, proposed, policy, { ...options, limit: 1 });
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["yp-payment-success"]);
    expect(result.candidates[0]?.blocking).toBe(true);
  });

  test("выдача добивается до limit кандидатами ниже review-порога", () => {
    const result = matchCandidates(CORPUS, { kind: "component", designSystem: "yandex-pay", name: "ZZTop", intent: "нечто несуществующее" }, policy, { ...options, limit: 3 });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((candidate) => candidate.score < policy.reviewThreshold)).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  test("propsDelta только у blocking-кандидатов и только именами", () => {
    const proposed: ProposedArtifact = {
      ...proposedPayButtonClone,
      meta: { propsJsonSchema: { type: "object", properties: { label: { type: "number" }, loading: { type: "boolean" } }, required: ["label"] }, events: ["press"], slots: [] },
    };
    const result = matchCandidates(CORPUS, proposed, withThresholds(0.5, 0.4), options);
    const top = result.blocking.find((candidate) => candidate.id === "yp-pay-button");
    expect(top?.propsDelta).toEqual({ added: ["loading"], removed: ["disabled"], typeChanged: ["label"] });
    const nonBlocking = result.candidates.find((candidate) => !candidate.blocking);
    expect(nonBlocking?.propsDelta).toBeUndefined();
  });

  test("сам оцениваемый артефакт исключается из корпуса (D4)", () => {
    const result = matchCandidates(CORPUS, { ...proposedPayButtonClone, id: "yp-pay-button" }, policy, { ...options, exclude: { designSystem: "yandex-pay", id: "yp-pay-button" } });
    expect(result.candidates.some((candidate) => candidate.id === "yp-pay-button")).toBe(false);
    expect(result.blocking).toEqual([]);
  });

  test("политика инъектируется: policyVersion возвращается вместе с результатом", () => {
    expect(matchCandidates(CORPUS, proposedPayButtonClone, { ...policy, policyVersion: 7 }, options).policyVersion).toBe(7);
  });

  test("IDF по умолчанию строится по корпусу, но явно переданный набор его вытесняет", () => {
    const pinned = matchCandidates(CORPUS, proposedPayButtonClone, policy, options);
    const derived = matchCandidates(CORPUS, proposedPayButtonClone, policy, {});
    expect(derived.candidates[0]?.id).toBe(pinned.candidates[0]?.id);
    expect(derived.candidates[0]?.blocking).toBe(true);
  });

  test("ядро не ходит в БД и в сеть — гейт вызывает его внутри синхронной транзакции", async () => {
    // Проверяются импорты и наличие `await`/`fetch` в коде, а не в комментариях: ядро обязано
    // оставаться синхронным и не зависеть ни от БД, ни от сети.
    for (const path of ["./matcher.ts", "./fingerprint.ts", "./policy.ts"]) {
      const text = await Bun.file(new URL(path, import.meta.url)).text();
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
      const allowed = new Set(["typescript", "../../src/capture/canonicalJson", "../../src/library/text", "./fingerprint", "./policy"]);
      for (const [, specifier] of code.matchAll(/from\s+"([^"]+)"/g)) expect([specifier, allowed.has(specifier ?? "")]).toEqual([specifier, true]);
      expect(code).not.toMatch(/\bawait\b/);
      expect(code).not.toMatch(/\bfetch\(/);
    }
  });

  test("калиброванная политика: инварианты и три обязательных сценария T0", () => {
    // Числа выбирает калибровка (`scripts/calibrate-matcher.ts`, отчёт
    // `docs/audit/2026-07-31-matcher-calibration.md`), а не этот тест — здесь фиксируется
    // только то, что политика прода вообще пригодна: веса нормированы, пороги упорядочены,
    // версия не provisional, и обязательные сценарии §10 под ней блокируются.
    expect(totalWeight(CALIBRATED_POLICY.weights)).toBeCloseTo(1, 10);
    expect(Object.values(CALIBRATED_POLICY.weights).every((weight) => weight > 0)).toBe(true);
    expect(CALIBRATED_POLICY.reviewThreshold).toBeLessThan(CALIBRATED_POLICY.blockingThreshold);
    expect(CALIBRATED_POLICY.policyVersion).toBeGreaterThanOrEqual(1);

    for (const proposed of [proposedPayButtonClone, { ...proposedPayButtonClone, description: "Совершенно другое описание" }, renamedCopyPaste]) {
      const [top] = matchCandidates(CORPUS, proposed, CALIBRATED_POLICY, options).candidates;
      expect([proposed.name, top?.id, top?.blocking]).toEqual([proposed.name, "yp-pay-button", true]);
    }
  });

  test("результат детерминирован: повторный прогон даёт побайтово тот же ответ", () => {
    const once = matchCandidates(CORPUS, renamedCopyPaste, policy, options);
    const twice = matchCandidates(CORPUS, renamedCopyPaste, policy, options);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

/**
 * Композиции в корпусе (план 2026-08-03 W9, находка R1-M9). Структурная сигнатура тела
 * приходит из `compositionSignature.ts`; матчеру важно лишь, что это множество токенов и
 * отпечаток, поэтому здесь они задаются вручную — ядро остаётся чистым.
 */
describe("matchCandidates — композиции", () => {
  const compositionCandidate = (overrides: Partial<CorpusCandidate> = {}): CorpusCandidate => ({
    kind: "composition",
    id: "yp-order-row",
    name: "YpOrderRow",
    designSystem: "yandex-pay",
    version: 1,
    draft: false,
    description: "Строка заказа с иконкой и кнопкой оплаты",
    canonicalFor: [],
    deprecated: false,
    headUsageCount: 2,
    meta: { propsJsonSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, events: [], slots: [] },
    shingles: new Set<string>(),
    structure: { shingles: new Set(["(Overlay(Image", "Overlay(Image)", "(Image)(Hotspot"]), fingerprint: "fp-order-row" },
    ...overrides,
  });

  const proposedComposition = (fingerprint: string, shingles: string[]): ProposedArtifact => ({
    kind: "composition",
    designSystem: "yandex-pay",
    id: "yp-order-line",
    name: "YpOrderLine",
    intent: "строка заказа с иконкой и кнопкой оплаты",
    description: "Строка заказа с иконкой и кнопкой оплаты",
    meta: { propsJsonSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, events: [], slots: [] },
    structure: { shingles: new Set(shingles), fingerprint },
  });

  test("равный отпечаток тела блокирует без порога — это и есть дубль композиции", () => {
    const result = matchCandidates([compositionCandidate()], proposedComposition("fp-order-row", ["(Overlay(Image"]), policy, options);
    const [top] = result.candidates;
    expect(top).toMatchObject({ kind: "composition", id: "yp-order-row", blocking: true });
    expect(top?.reasons).toContain("identical composition body signature");
  });

  test("другой отпечаток: сигнал тела считается Jaccard'ом структурных шинглов", () => {
    const partial = matchCandidates([compositionCandidate()], proposedComposition("fp-other", ["(Overlay(Image", "Overlay(Image)"]), policy, options);
    expect(partial.candidates[0]?.blocking).toBe(false);
    expect(partial.candidates[0]?.signals.source).toBeCloseTo(2 / 3, 10);

    const disjoint = matchCandidates([compositionCandidate()], proposedComposition("fp-other", ["(Screen(Text"]), policy, options);
    expect(disjoint.candidates[0]?.signals.source).toBe(0);
  });

  /**
   * Кросс-типовой мэтч. Шинглы TSX и шинглы структуры живут в разных словарях: с весом 0.75
   * их нулевой Jaccard утопил бы любую пару «композиция ↔ компонент», поэтому сигнал тела
   * между типами **неприменим**, а не равен нулю.
   */
  test("сигнал тела неприменим между компонентом и композицией", () => {
    const component = activeCandidate({ id: "yp-order-row-component", name: "YpOrderRow", shingles: sourceShingles(PROMO_CARD_SOURCE) });
    const [top] = matchCandidates([component], proposedComposition("fp-order-row", ["(Overlay(Image"]), policy, options).candidates;
    expect(top?.signals.source).toBeUndefined();
    // Отпечаток контракта между типами тоже не блокирует: совпавшая сигнатура props — это
    // подсказка «расширь компонент», а не тождество артефактов.
    expect(top?.blocking).toBe(false);
  });

  test("пороги задаются по типу артефакта: policyByKind не трогает компоненты", () => {
    const corpus = [compositionCandidate({ structure: { shingles: new Set(["(Overlay(Image"]), fingerprint: "fp-other" } }), payButton];
    const strict: MatchPolicy = { ...policy, blockingThreshold: 0.95, reviewThreshold: 0.9 };
    const result = matchCandidates(corpus, proposedPayButtonClone, policy, { ...options, policyByKind: { composition: strict } });
    // Компонент-дубль по-прежнему блокируется общей политикой…
    expect(result.candidates.find((candidate) => candidate.kind === "component")?.blocking).toBe(true);
    // …а композиция судится своими порогами и в relevant-набор не попадает.
    expect(result.blocking.some((candidate) => candidate.kind === "composition")).toBe(false);
  });
});
