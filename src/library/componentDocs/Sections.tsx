import { RawJson } from "./RawJson";
import { componentDocsStrings as strings } from "./strings";

export interface ComponentDocsMeta {
  description?: string;
  atomicLevel?: string;
  layoutNeutral?: boolean;
  capabilities?: { typedEvents?: true; namedSlots?: true };
  example?: Record<string, unknown>;
  examples?: Record<string, Record<string, unknown>>;
}

export function EventsSection({ events, eventPayloads }: {
  events?: readonly string[];
  eventPayloads?: Record<string, unknown>;
}) {
  const names = [...new Set([...(events ?? []), ...Object.keys(eventPayloads ?? {}).sort()])];
  return <section aria-labelledby="component-events-title">
    <h2 id="component-events-title">{strings.eventsTitle}</h2>
    {names.length === 0 ? <p>{strings.noEvents}</p> : <div className="overflow-x-auto">
      <table className="min-w-full text-left">
        <caption className="sr-only">{strings.eventsTitle}</caption>
        <thead><tr><th scope="col">{strings.eventName}</th><th scope="col">{strings.eventPayload}</th></tr></thead>
        <tbody>{names.map((name) => <tr key={name}>
          <th scope="row">{name}</th>
          <td>{eventPayloads && Object.hasOwn(eventPayloads, name)
            ? <RawJson value={eventPayloads[name]} />
            : strings.noPayload}</td>
        </tr>)}</tbody>
      </table>
    </div>}
  </section>;
}

export function SlotsSection({ slots }: { slots?: readonly string[] }) {
  return <section aria-labelledby="component-slots-title">
    <h2 id="component-slots-title">{strings.slotsTitle}</h2>
    {!slots?.length ? <p>{strings.noSlots}</p> : <div className="overflow-x-auto">
      <table className="min-w-full text-left">
        <caption className="sr-only">{strings.slotsTitle}</caption>
        <thead><tr><th scope="col">{strings.slotName}</th></tr></thead>
        <tbody>{slots.map((slot) => <tr key={slot}><th scope="row">{slot}</th></tr>)}</tbody>
      </table>
    </div>}
  </section>;
}

export function MetaSection({ meta }: { meta?: ComponentDocsMeta }) {
  const capabilities = [
    ...(meta?.capabilities?.typedEvents ? [strings.typedEvents] : []),
    ...(meta?.capabilities?.namedSlots ? [strings.namedSlots] : []),
  ];
  const examples: [string, unknown][] = [
    ...(meta?.example ? [[strings.defaultExample, meta.example] as [string, unknown]] : []),
    ...Object.entries(meta?.examples ?? {}),
  ];
  return <section aria-labelledby="component-meta-title">
    <h2 id="component-meta-title">{strings.metaTitle}</h2>
    <dl>
      <dt>{strings.description}</dt><dd>{meta?.description || strings.noDescription}</dd>
      <dt>{strings.atomicLevel}</dt><dd>{meta?.atomicLevel ?? strings.notSet}</dd>
      <dt>{strings.layoutNeutral}</dt><dd>{meta?.layoutNeutral === undefined ? strings.notSet : meta.layoutNeutral ? strings.yes : strings.no}</dd>
      <dt>{strings.capabilities}</dt><dd>{capabilities.length ? capabilities.join(", ") : strings.noCapabilities}</dd>
      <dt>{strings.examples}</dt><dd>{examples.length ? <ul>{examples.map(([name, value]) => <li key={name}>
        <RawJson value={value} summary={name} />
      </li>)}</ul> : strings.noExamples}</dd>
    </dl>
  </section>;
}
