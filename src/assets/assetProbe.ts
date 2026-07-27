/**
 * Клиентский замер изображения: фактические `naturalWidth`/`naturalHeight` и наличие
 * прозрачности. Прозрачность считается семплированием canvas'а — это деградируемая
 * проверка: в SSR/jsdom, при отказе 2d-контекста и при tainted canvas (SecurityError)
 * возвращается `alpha: "unknown"`, и UI обязан показать «не определено», а не «непрозрачный».
 */

export type AlphaVerdict = "opaque" | "alpha" | "unknown";

export interface AssetProbe {
  naturalWidth: number | null;
  naturalHeight: number | null;
  alpha: AlphaVerdict;
}

export const UNKNOWN_PROBE: AssetProbe = { naturalWidth: null, naturalHeight: null, alpha: "unknown" };

/** Сторона квадрата семпла: полноразмерный getImageData не нужен для факта «есть alpha». */
const SAMPLE_SIDE = 48;
/** Пиксель считается прозрачным, начиная с этого значения альфы (сглаживание краёв — тоже alpha). */
const ALPHA_THRESHOLD = 250;

function detectAlpha(image: HTMLImageElement, width: number, height: number): AlphaVerdict {
  if (typeof document === "undefined" || !width || !height) return "unknown";
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, SAMPLE_SIDE / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return "unknown";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    if (!data.length) return "unknown";
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] < ALPHA_THRESHOLD) return "alpha";
    }
    return "opaque";
  } catch {
    // Tainted canvas / отключённый canvas в тестовой среде — честное «не определено».
    return "unknown";
  }
}

export function probeLoadedImage(image: HTMLImageElement): AssetProbe {
  const naturalWidth = image.naturalWidth || null;
  const naturalHeight = image.naturalHeight || null;
  if (naturalWidth === null || naturalHeight === null) return { naturalWidth, naturalHeight, alpha: "unknown" };
  return { naturalWidth, naturalHeight, alpha: detectAlpha(image, naturalWidth, naturalHeight) };
}
