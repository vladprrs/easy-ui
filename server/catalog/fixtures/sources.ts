/**
 * Исходники фикстур матчера. Держатся строками (а не `.tsx`-файлами), чтобы:
 * 1) не попадать в сборку и в typecheck как настоящие компоненты;
 * 2) тест мог сравнивать **побайтово идентичные** и **переименованные** варианты одного кода.
 */

export const PAY_BUTTON_SOURCE = `import { z } from "zod";
import { token } from "easy-ui/runtime/v4";

export const definition = {
  props: z.object({ label: z.string(), disabled: z.boolean().optional() }),
  events: ["press"],
  description: "Кнопка оплаты Яндекс Пэй",
  atomicLevel: "molecule",
  scope: "primitive",
};

export default function YpPayButton({ label, disabled, onPress }) {
  const background = token("color-brand");
  return (
    <button className="yp-pay-button" disabled={disabled} style={{ background }} onClick={onPress}>
      <span className="yp-pay-button__label">{label}</span>
    </button>
  );
}
`;

/**
 * Тот же код: переименованы компонент, локальные переменные и параметры, изменены литералы,
 * добавлены комментарии и переставлены пробелы. Структура (JSX-теги, имена атрибутов и пропов)
 * не тронута — нормализация обязана свести оба варианта к почти одинаковым шинглам.
 */
export const RENAMED_PAY_BUTTON_SOURCE = `import { z as schema } from "zod";
// Кнопка чекаута — форк платёжной кнопки.
import { token as designToken } from "easy-ui/runtime/v4";

export const definition = {
  props: schema.object({ label: schema.string(), disabled: schema.boolean().optional() }),
  events: ["press"],
  description: "Кнопка перехода к оплате",
  atomicLevel: "molecule",
  scope: "primitive",
};

export default function YpCheckoutButton({ label, disabled, onPress }) {
  const brandBackground = designToken("color-checkout");
  return (
    <button className="yp-checkout-button"  disabled={disabled}  style={{ background: brandBackground }}  onClick={onPress}>
      <span className="yp-checkout-button__label">{label}</span>
    </button>
  );
}
`;

/** Совсем другой компонент: другая форма, другие пропы, другой JSX. */
export const PROMO_CARD_SOURCE = `import { z } from "zod";

export const definition = {
  props: z.object({ title: z.string(), imageUrl: z.string(), cashback: z.number() }),
  slots: ["footer"],
  description: "Промо-карточка кэшбэка",
  atomicLevel: "organism",
  scope: "section",
};

export default function YpPromoCard({ title, imageUrl, cashback, footer }) {
  return (
    <section className="yp-promo-card">
      <img src={imageUrl} alt="" />
      <h3>{title}</h3>
      <p>{cashback}</p>
      <footer>{footer}</footer>
    </section>
  );
}
`;

/** Каноническая роль payment-success: намеренно не похож на кнопку ничем, кроме роли. */
export const SUCCESS_SCREEN_SOURCE = `import { z } from "zod";

export const definition = {
  props: z.object({ amount: z.string(), merchant: z.string() }),
  description: "Экран успешной оплаты",
  canonicalFor: ["payment-success"],
  atomicLevel: "page",
  scope: "screen",
};

export default function YpPaymentSuccess({ amount, merchant }) {
  return (
    <main className="yp-success">
      <h1>{amount}</h1>
      <h2>{merchant}</h2>
    </main>
  );
}
`;

export const RATING_STARS_SOURCE = `import { z } from "zod";

export const definition = {
  props: z.object({ value: z.number() }),
  description: "Рейтинг звёздами",
  atomicLevel: "atom",
  scope: "primitive",
};

export default function UiRatingStars({ value }) {
  return <div className="stars">{value}</div>;
}
`;
