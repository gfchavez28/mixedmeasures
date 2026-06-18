import React from 'react'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ChartErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Chart rendering error:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className="flex flex-col items-center justify-center h-64 text-mm-text-faint text-sm gap-2 p-4">
          <span>Chart failed to render</span>
          <span className="text-xs text-mm-border-medium max-w-md text-center">
            {this.state.error?.message}
          </span>
          <button
            className="text-xs text-blue-500 hover:text-blue-700 underline focus:outline-none focus:ring-2 focus:ring-ring rounded"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
