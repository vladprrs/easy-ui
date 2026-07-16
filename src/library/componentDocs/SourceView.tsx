export function SourceView({ source }: { source: string }) {
  return <pre className="max-w-full overflow-x-auto whitespace-pre">{source}</pre>;
}
