import { lazy } from 'react'
import { Routes, Route, Navigate, useParams } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from '@/lib/auth-context'
import { ThemeProvider } from '@/lib/theme-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import Dashboard from '@/pages/Dashboard'
import ProjectLayout from '@/layouts/ProjectLayout'
import OverviewPage from '@/pages/OverviewPage'
import ConversationsListPage from '@/pages/ConversationsListPage'
import DatasetsListPage from '@/pages/DatasetsListPage'
import DocumentsListPage from '@/pages/DocumentsListPage'
import AnalysisHubPage from '@/pages/AnalysisHubPage'
import ParticipantsPage from '@/pages/ParticipantsPage'
import MemosNotesPage from '@/pages/MemosNotesPage'
import SettingsPage from '@/pages/SettingsPage'

// Lazy-loaded pages — heavy workbenches and import flows split into separate chunks
const ConversationImport = lazy(() => import('./pages/ConversationImport'))
const CodingWorkbench = lazy(() => import('./pages/CodingWorkbench'))
const DatasetImport = lazy(() => import('./pages/DatasetImport'))
const DatasetView = lazy(() => import('./pages/DatasetView'))
const RecodeWorkbench = lazy(() => import('./pages/RecodeWorkbench'))
const AppendImport = lazy(() => import('./pages/AppendImport'))
const CrosswalkView = lazy(() => import('./pages/CrosswalkView'))
const TextCodingView = lazy(() => import('./pages/TextCodingView'))
const DocumentImport = lazy(() => import('./pages/DocumentImport'))
const DocumentCodingWorkbench = lazy(() => import('./pages/DocumentCodingWorkbench'))
const AnalysisView = lazy(() => import('./pages/AnalysisView'))
const QualitativeAnalysisView = lazy(() => import('./pages/QualitativeAnalysisView'))
const CanvasView = lazy(() => import('./pages/CanvasView'))
const CanvasCompareView = lazy(() => import('./pages/CanvasCompareView'))
const CodebookView = lazy(() => import('./pages/CodebookView'))

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  // Local-first: there is no login. AuthProvider auto-authenticates via /status
  // (a coder is auto-provisioned), so we only gate on the initial load.
  const { isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  return <>{children}</>
}

function LegacyRedirect({ to }: { to: string }) {
  const { projectId } = useParams()
  return <Navigate to={`/projects/${projectId}/${to}`} replace />
}

function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <SettingsPage />
          </ProtectedRoute>
        }
      />

      {/* Project layout with nested routes */}
      <Route
        path="/projects/:projectId"
        element={
          <ProtectedRoute>
            <ProjectLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="conversations" element={<ConversationsListPage />} />
        <Route path="conversations/import" element={<ConversationImport />} />
        <Route path="conversations/:conversationId" element={<CodingWorkbench />} />
        <Route path="datasets" element={<DatasetsListPage />} />
        <Route path="datasets/import" element={<DatasetImport />} />
        <Route path="datasets/variable-groups" element={<CrosswalkView />} />
        <Route path="datasets/text-coding" element={<TextCodingView />} />
        <Route path="datasets/:datasetId" element={<DatasetView />} />
        <Route path="datasets/:datasetId/recode" element={<RecodeWorkbench />} />
        <Route path="datasets/:datasetId/append" element={<AppendImport />} />
        <Route path="documents" element={<DocumentsListPage />} />
        <Route path="documents/import" element={<DocumentImport />} />
        <Route path="documents/:documentId" element={<DocumentCodingWorkbench />} />
        <Route path="analysis" element={<AnalysisHubPage />} />
        <Route path="analysis/qualitative" element={<QualitativeAnalysisView />} />
        <Route path="analysis/quantitative" element={<AnalysisView />} />
        <Route path="analysis/canvas" element={<CanvasView />} />
        <Route path="analysis/canvas/compare" element={<CanvasCompareView />} />
        <Route path="analysis/integrated" element={<Navigate to="canvas" replace />} />
        <Route path="analysis/codebook" element={<CodebookView />} />
        <Route path="participants" element={<ParticipantsPage />} />
        <Route path="starred" element={<Navigate to="../analysis/qualitative?tab=quoteboard" replace />} />
        <Route path="memos-notes" element={<MemosNotesPage />} />
      </Route>

      {/* Legacy redirects for old bookmarked URLs */}
      <Route path="/projects/:projectId/import" element={<ProtectedRoute><LegacyRedirect to="conversations/import" /></ProtectedRoute>} />
      <Route path="/projects/:projectId/variable-groups" element={<ProtectedRoute><LegacyRedirect to="datasets/variable-groups" /></ProtectedRoute>} />
      <Route path="/projects/:projectId/equivalence" element={<ProtectedRoute><LegacyRedirect to="datasets/variable-groups" /></ProtectedRoute>} />
      <Route path="/projects/:projectId/domains" element={<ProtectedRoute><LegacyRedirect to="datasets/variable-groups" /></ProtectedRoute>} />
      <Route path="/projects/:projectId/qualitative-analysis" element={<ProtectedRoute><LegacyRedirect to="analysis/qualitative" /></ProtectedRoute>} />
      <Route path="/projects/:projectId/analysis" element={<ProtectedRoute><LegacyRedirect to="analysis/quantitative" /></ProtectedRoute>} />
      <Route path="/projects/:projectId/charts" element={<ProtectedRoute><LegacyRedirect to="analysis/quantitative" /></ProtectedRoute>} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <TooltipProvider>
          <AppRoutes />
        </TooltipProvider>
        <Toaster
          position="bottom-right"
          toastOptions={{
            className: 'bg-mm-surface text-mm-text border-mm-surface-border',
          }}
        />
      </ThemeProvider>
    </AuthProvider>
  )
}
