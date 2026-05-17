'use client';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Top-level boundary so a crash inside any panel (wizard, thread, sidebar)
// shows a friendly fallback instead of a white screen. React errors thrown
// during render or in lifecycle methods bubble here.
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to console so dev tools / sync-events.log pick it up.
    console.error('[AppErrorBoundary]', error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  reload = () => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-screen flex items-center justify-center bg-[var(--color-bg)] p-6">
        <div
          className="card max-w-md w-full p-7 text-center"
          style={{ boxShadow: 'var(--shadow-raised)' }}
        >
          <div className="w-12 h-12 rounded-full bg-[var(--color-danger)]/10 flex items-center justify-center mx-auto mb-3">
            <span className="text-[var(--color-danger)] text-[20px] font-semibold">!</span>
          </div>
          <h1 className="text-[18px] font-semibold tracking-tight text-[var(--color-text-primary)]">
            Something went wrong
          </h1>
          <p className="text-[12.5px] text-[var(--color-text-secondary)] mt-2 leading-relaxed">
            InboxPro hit an unexpected error. Your data is safe — try reloading.
          </p>
          <pre className="mt-4 p-3 rounded-lg bg-[var(--color-surface-2)] text-[11px] text-[var(--color-text-tertiary)] text-left overflow-auto max-h-32 mono">
            {error.message}
          </pre>
          <div className="flex gap-2 justify-center mt-5">
            <button
              onClick={this.reset}
              className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
              style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
            >
              Try again
            </button>
            <button
              onClick={this.reload}
              className="px-4 py-1.5 rounded-lg text-[12.5px] font-semibold bg-[var(--color-accent-deep)] hover:bg-[var(--color-accent)] text-white"
              style={{ transition: 'background-color 140ms var(--ease-out-quart)' }}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
