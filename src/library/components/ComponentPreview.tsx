import { useEffect, useRef, useState, type ReactElement } from "react";
import { library } from "../../app/strings/library";

export interface ComponentPreviewProps {
  componentId: string;
  componentName: string;
  version: number;
  /** Имя примера из `examples` или `null` — тогда берётся `example` (props=example). */
  example: string | null;
}

/**
 * Живое превью компонента в карточке (макет 06): страница `/capture/component/...`
 * в iframe, отрисованная темой своей дизайн-системы.
 *
 * Каталог одной системы бывает на сотню компонентов, поэтому iframe создаётся
 * только когда карточка подошла к вьюпорту (тот же приём, что в GalleryPreview):
 * без гейта браузер тянул бы все бандлы разом. В jsdom IntersectionObserver нет —
 * там превью монтируется сразу, чтобы тесты видели адрес.
 */
/**
 * Подгоняет содержимое capture-страницы под превью-зону: центрирует и, если
 * компонент крупнее зоны, уменьшает его целиком, а не показывает левый верхний угол.
 *
 * Правки живут только в документе iframe и только для витрины — сам маршрут
 * `/capture/...` не меняется, поэтому серверные скриншоты и визуальные эталоны
 * снимаются ровно как раньше. Любой сбой (нет доступа, поменялась разметка)
 * гасится: превью — украшение карточки, а не её содержание.
 */
function fitCaptureDocument(frame: HTMLIFrameElement): (() => void) | undefined {
  try {
    const doc = frame.contentDocument;
    if (!doc?.body) return undefined;
    doc.documentElement.style.background = "transparent";
    Object.assign(doc.body.style, {
      background: "transparent",
      height: "100%",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    });
    const fit = () => {
      const surface = doc.getElementById("eui-capture-surface");
      if (!surface) return;
      surface.style.transform = "";
      const { width, height } = surface.getBoundingClientRect();
      const scale = Math.min(1, (frame.clientWidth - 24) / (width || 1), (frame.clientHeight - 24) / (height || 1));
      if (scale < 1) surface.style.transform = `scale(${scale})`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(doc.body);
    return () => observer.disconnect();
  } catch { return undefined; }
}

export function ComponentPreview({ componentId, componentName, version, example }: ComponentPreviewProps): ReactElement {
  const rootRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => () => cleanupRef.current?.(), []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setVisible(true);
    }, { rootMargin: "240px 0px" });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const query = example === null ? "props=example" : `example=${encodeURIComponent(example)}`;
  const src = `/capture/component/${encodeURIComponent(componentId)}/${version}?${query}`;
  return <div
    ref={rootRef}
    className="absolute inset-0"
    data-component-preview={componentId}
    data-component-preview-mounted={visible ? "true" : "false"}
  >
    {visible ? <iframe
      // Превью нерабочее по замыслу: карточка целиком — ссылка на страницу компонента.
      className="pointer-events-none h-full w-full"
      loading="lazy"
      tabIndex={-1}
      title={library.previewAria(componentName)}
      src={src}
      onLoad={(event) => {
        cleanupRef.current?.();
        cleanupRef.current = fitCaptureDocument(event.currentTarget);
      }}
    /> : null}
  </div>;
}

/** Компонент без example-props: вместо превью — честная плашка, а не пустая зона. */
export function ComponentPreviewMissing(): ReactElement {
  return <p className="px-5 text-center text-[13px] text-eui-slate-500">{library.previewMissing}</p>;
}
