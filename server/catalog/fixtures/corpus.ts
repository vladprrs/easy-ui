/**
 * Запинённый корпус матчера. Две вещи здесь обязательны и не косметика:
 *
 * 1. **IDF пинится явно** (`FIXTURE_DESCRIPTIONS`), а не выводится из массива корпуса: IDF
 *    корпус-относителен, и добавление новой фикстуры иначе сдвигало бы вес каждого токена —
 *    тесты порогов начали бы флапать от несвязанной правки.
 * 2. Шинглы считаются из тех же исходников, что и у предложения в тестах, — так «побайтово
 *    идентичный дубликат» остаётся побайтово идентичным.
 */

import { buildIdf } from "../../../src/library/text";
import { sourceShingles } from "../fingerprint";
import type { CorpusCandidate } from "../matcher";
import { PAY_BUTTON_SOURCE, PROMO_CARD_SOURCE, RATING_STARS_SOURCE, SUCCESS_SCREEN_SOURCE } from "./sources";

export const PAY_BUTTON_SCHEMA = {
  type: "object",
  properties: { label: { type: "string" }, disabled: { type: "boolean" } },
  required: ["label"],
  additionalProperties: false,
} as const;

const PROMO_CARD_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, imageUrl: { type: "string" }, cashback: { type: "number" } },
  required: ["title", "imageUrl", "cashback"],
  additionalProperties: false,
} as const;

const SUCCESS_SCHEMA = {
  type: "object",
  properties: { amount: { type: "string" }, merchant: { type: "string" } },
  required: ["amount", "merchant"],
  additionalProperties: false,
} as const;

const RATING_SCHEMA = { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false } as const;
const STARS_SCHEMA = { type: "object", properties: { value: { type: "number" }, max: { type: "number" } }, required: ["value"], additionalProperties: false } as const;

/** Описания, по которым считается IDF фикстур. Список фиксирован намеренно — см. шапку файла. */
export const FIXTURE_DESCRIPTIONS: readonly string[] = Object.freeze([
  "Кнопка оплаты Яндекс Пэй",
  "Промо-карточка кэшбэка",
  "Экран успешной оплаты",
  "Рейтинг звёздами",
  "Звёздный рейтинг с максимумом",
  "Payment button with loading state",
  "Cashback promo card",
]);

export const FIXTURE_IDF = buildIdf(FIXTURE_DESCRIPTIONS);

type CandidateOverrides = Partial<CorpusCandidate> & Pick<CorpusCandidate, "id" | "name">;

/** Активная публикация с разумными дефолтами: фикстуры перечисляют только значимые поля. */
export function activeCandidate(overrides: CandidateOverrides): CorpusCandidate {
  return {
    kind: "component",
    designSystem: "yandex-pay",
    version: 1,
    draft: false,
    description: "",
    deprecated: false,
    headUsageCount: 0,
    shingles: new Set<string>(),
    ...overrides,
  };
}

/** Head-драфт: без `definition_meta`, а значит без props/io/atomicLevel/scope/description. */
export function draftCandidate(id: string, name: string, source: string): CorpusCandidate {
  return activeCandidate({ id, name, version: 0, draft: true, shingles: sourceShingles(source) });
}

export const payButton = activeCandidate({
  id: "yp-pay-button",
  name: "YpPayButton",
  description: "Кнопка оплаты Яндекс Пэй",
  atomicLevel: "molecule",
  scope: "primitive",
  headUsageCount: 12,
  meta: { propsJsonSchema: PAY_BUTTON_SCHEMA, events: ["press"], slots: [] },
  shingles: sourceShingles(PAY_BUTTON_SOURCE),
});

export const promoCard = activeCandidate({
  id: "yp-promo-card",
  name: "YpPromoCard",
  description: "Промо-карточка кэшбэка",
  atomicLevel: "organism",
  scope: "section",
  headUsageCount: 3,
  meta: { propsJsonSchema: PROMO_CARD_SCHEMA, events: [], slots: ["footer"] },
  shingles: sourceShingles(PROMO_CARD_SOURCE),
});

export const successScreen = activeCandidate({
  id: "yp-payment-success",
  name: "YpPaymentSuccess",
  description: "Экран успешной оплаты",
  atomicLevel: "page",
  scope: "screen",
  canonicalFor: ["payment-success"],
  meta: { propsJsonSchema: SUCCESS_SCHEMA, events: [], slots: [] },
  shingles: sourceShingles(SUCCESS_SCREEN_SOURCE),
});

/** Deprecated с заменой: `replacement` указывает на активный `UiStars` в том же корпусе. */
export const ratingStars = activeCandidate({
  id: "ui-rating-stars",
  name: "UiRatingStars",
  description: "Рейтинг звёздами",
  atomicLevel: "atom",
  scope: "primitive",
  deprecated: true,
  replacement: "UiStars",
  meta: { propsJsonSchema: RATING_SCHEMA, events: [], slots: [] },
  shingles: sourceShingles(RATING_STARS_SOURCE),
});

export const stars = activeCandidate({
  id: "ui-stars",
  name: "UiStars",
  description: "Звёздный рейтинг с максимумом",
  atomicLevel: "atom",
  scope: "primitive",
  meta: { propsJsonSchema: STARS_SCHEMA, events: [], slots: [] },
  shingles: sourceShingles(RATING_STARS_SOURCE),
});

/** Полный структурный близнец платёжной кнопки в **другой** дизайн-системе. */
export const shadcnPayButton = activeCandidate({
  id: "sh-pay-button",
  name: "PayButton",
  designSystem: "shadcn",
  description: "Payment button with loading state",
  atomicLevel: "molecule",
  scope: "primitive",
  meta: { propsJsonSchema: PAY_BUTTON_SCHEMA, events: ["press"], slots: [] },
  shingles: sourceShingles(PAY_BUTTON_SOURCE),
});

export const CORPUS: readonly CorpusCandidate[] = Object.freeze([payButton, promoCard, successScreen, ratingStars, stars, shadcnPayButton]);
