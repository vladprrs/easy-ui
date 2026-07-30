/**
 * Классы-пресеты хрома easy-ui в бренде Пэй (редизайн 2026-07-30).
 *
 * Правила бренда, которым подчинён каждый пресет ниже:
 * — теней, бордеров и градиентов нет; иерархия только цветом (белая панель на
 *   лавандовой канве), единственная «граница» — outline 2px лаванда у поповеров;
 * — hover затемняет заливку на 4–6% (`brightness-95`), без движения и масштаба,
 *   переходов длиннее 120ms не бывает;
 * — фокус — красный outline 2px offset 2px (глобальное правило в `styles/index.css`);
 * — ALL-CAPS в интерфейсе нет.
 */

/** Белая панель — базовая поверхность всех экранов на лавандовой канве. */
export const panel = "rounded-panel bg-white";
/** Панель с каноническим внутренним отступом (24–28). */
export const panelPadded = "rounded-panel bg-white p-6";
/** Лавандовая вставка внутри белой панели (ленты тайлов, подсказки). */
export const inset = "rounded-inset bg-pay-lavender";

export const transition = "transition-colors duration-100";

/** Primary: красная пилюля, белый текст. Один-два на экран. */
export const pillPrimary =
  `inline-flex items-center justify-center rounded-full bg-pay-red px-[26px] py-[13px] text-[15px] font-medium text-white ${transition} hover:brightness-95`;
/** Secondary: лавандовая пилюля. Дефолт для всех неглавных действий. */
export const pillGhost =
  `inline-flex items-center justify-center rounded-full bg-pay-lavender px-4 py-2 text-sm font-medium text-eui-ink ${transition} hover:brightness-95 disabled:hover:brightness-100`;
/** Тёмная пилюля: включённый тумблер, выбранный сценарий, подписи зон. */
export const pillDeep =
  `inline-flex items-center justify-center rounded-full bg-pay-deep px-4 py-2 text-sm font-medium text-white ${transition} hover:brightness-125`;
/** Пилюля на тёмно-пурпурной поверхности (лайтбокс, презентация). */
export const pillGhostOnDark =
  `inline-flex items-center justify-center rounded-full bg-pay-lavender/15 px-4 py-2 text-sm font-medium text-pay-lavender ${transition} hover:bg-pay-lavender/25`;

/**
 * Пилюля прямо на лавандовой канве (тулбары): лаванда-на-лаванде не читается,
 * поэтому фон белый. Выбранное состояние — тёмная пилюля, как у всех тумблеров.
 */
export const pillWhite =
  `inline-flex items-center justify-center rounded-full bg-white px-4 py-2 text-sm font-medium text-eui-ink ${transition} hover:brightness-95`;

/** Чип-фильтр в покое и выбранный. */
export const chip =
  `inline-flex items-center rounded-full bg-pay-lavender px-3 py-1 text-xs font-medium text-eui-ink ${transition} hover:brightness-95`;
export const chipActive =
  `inline-flex items-center rounded-full bg-pay-deep px-3 py-1 text-xs font-medium text-white ${transition}`;

/**
 * Сегмент-контрол (Мои/Все, Сценарии/Дорожки/Плеер): приглушённый трек, активный
 * сегмент — белая пилюля. Один и тот же паттерн на всех поверхностях.
 */
export const segmentTrack = "inline-flex items-center gap-1 rounded-full bg-pay-deep/[0.06] p-1 text-sm";
const segmentBase = `inline-flex shrink-0 items-center rounded-full px-4 py-1.5 ${transition}`;
export const segmentActive = `${segmentBase} bg-white font-medium text-eui-ink`;
export const segmentIdle = `${segmentBase} text-eui-slate-500 hover:text-eui-ink`;

/** Поля ввода: лавандовый тинт, радиус 14, без бордера. */
export const inputBase =
  "rounded-field bg-pay-lavender-tint px-4 py-[13px] text-sm text-eui-ink placeholder:text-eui-slate-400";
/** Подпись поля — 13/500 над самим полем. */
export const inputLabel = "block text-[13px] font-medium text-eui-ink";

/** Поповер: белая панель, оторванная от белого фона лавандовым outline. */
export const popover = "rounded-popover bg-white p-2 outline-2 outline-pay-lavender";
export const popoverItem =
  `flex w-full items-center gap-2 rounded-item px-3 py-2 text-left text-sm text-eui-ink ${transition} hover:bg-pay-lavender`;

/** Надзаголовок секции: 13/500 приглушённым, без капса и трекинга (правило бренда). */
export const kicker = "text-[13px] font-medium text-eui-slate-500";
export const kickerOnDark = "text-[13px] font-medium text-pay-lavender/70";

/** Крупные заголовки — дисплейной гарнитурой; имена и подзаголовки — YS Text. */
export const headingHero = "pay-display text-[76px] leading-[0.84] text-eui-ink";
export const headingPage = "pay-display text-[34px] leading-[0.9] text-eui-ink";
export const headingDialog = "pay-display text-[32px] leading-[0.9] text-eui-ink";
export const headingBar = "text-xl font-medium text-eui-ink";

/** Плитки-панели (карточки галереи, секции сценариев). */
export const plate = panelPadded;
export const card = panelPadded;
