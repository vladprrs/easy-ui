import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

// Замена iframe-хака `fitCaptureDocument`: превью рендерится в реальном DOM страницы, поэтому подгон
// делается ResizeObserver-ом и трансформом, а не правкой чужого документа.

/** Поля между содержимым и краем превью-зоны — как у прежнего iframe-подгона (24px по обеим осям). */
export const FIT_GUTTER = 12;

export interface FitToBoxProps {
  children: ReactNode;
  className?: string;
  gutter?: number;
}

/**
 * Вписывает содержимое в свою зону: центрирует и уменьшает, если оно крупнее.
 *
 * `transform` ставится **всегда, даже при k=1**: трансформ создаёт containing block, поэтому
 * `position:fixed`/`100vh` внутри компонента остаются внутри карточки. Публикация такие исходники
 * только предупреждает (`server/routes/components.ts:44-46`), раньше их «вьюпортом» был iframe.
 * `contain`/`isolation`/`overflow` добивают изоляцию: ни выкатиться, ни всплыть над хромом.
 */
export function FitToBox({ children, className, gutter = FIT_GUTTER }: FitToBoxProps): ReactElement {
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const content = contentRef.current;
    if (!box || !content) return;
    const measure = () => {
      // offsetWidth/offsetHeight — геометрия ДО трансформа, поэтому замер не зависит от текущего
      // масштаба и наблюдатель не зацикливается на собственном же результате.
      const width = content.offsetWidth;
      const height = content.offsetHeight;
      const availableWidth = box.clientWidth - gutter * 2;
      const availableHeight = box.clientHeight - gutter * 2;
      if (width <= 0 || height <= 0 || availableWidth <= 0 || availableHeight <= 0) { setScale(1); return; }
      const next = Math.min(1, availableWidth / width, availableHeight / height);
      setScale((previous) => Math.abs(previous - next) < 0.005 ? previous : Math.max(next, 0.05));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return; // jsdom: остаёмся на замере при монтировании
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(content);
    return () => observer.disconnect();
  }, [gutter]);

  return <div
    ref={boxRef}
    data-fit-to-box=""
    className={`flex h-full w-full items-center justify-center ${className ?? ""}`}
    style={{ overflow: "hidden", isolation: "isolate", contain: "layout paint" }}
  >
    <div
      ref={contentRef}
      data-fit-to-box-content=""
      // flexShrink: 0 — иначе флекс сжал бы содержимое до ширины зоны и замер вернул бы саму зону.
      style={{ flexShrink: 0, transform: `scale(${scale})`, transformOrigin: "center center" }}
    >
      {children}
    </div>
  </div>;
}
