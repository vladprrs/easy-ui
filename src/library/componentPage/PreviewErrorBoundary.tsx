import { Component, type ReactNode } from "react";
import { componentPage as strings } from "../../app/strings/componentPage";

type Props = { children: ReactNode; resetGeneration: number; reportedError: boolean; onErrorStateChange: (errored: boolean) => void };
type State = { error: Error | null };

export class PreviewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    return props.reportedError && state.error === null ? { error: new Error("reported runtime error") } : null;
  }

  componentDidCatch() { this.props.onErrorStateChange(true); }

  componentDidUpdate(previous: Props) {
    if (!previous.reportedError && this.props.reportedError && this.state.error) this.props.onErrorStateChange(true);
    if (this.state.error && previous.resetGeneration !== this.props.resetGeneration) {
      this.setState({ error: null });
      this.props.onErrorStateChange(false);
    }
  }

  render() {
    return this.state.error
      ? <div role="alert" className="rounded-2xl bg-eui-lilac-100 p-5 text-sm text-eui-magenta">{strings.previewCrashed}</div>
      : this.props.children;
  }
}
