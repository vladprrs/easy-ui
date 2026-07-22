const updatedAtFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function formatGalleryUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : updatedAtFormatter.format(date);
}
