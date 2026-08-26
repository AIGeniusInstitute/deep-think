import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { SetupPage } from './pages/SetupPage';
import { SetupProvidersPage } from './pages/SetupProvidersPage';
import { SetupChannelsPage } from './pages/SetupChannelsPage';
import { MemoryPage } from './pages/MemoryPage';
import { SkillsPage } from './pages/SkillsPage';
import { McpServersPage } from './pages/McpServersPage';
import { McpRegistryPage } from './pages/McpRegistryPage';
import { PluginsPage } from './pages/PluginsPage';
import { AgentDefinitionsPage } from './pages/AgentDefinitionsPage';
import { KnowledgeBasesPage } from './pages/KnowledgeBasesPage';
import { AgentStudioPage } from './pages/AgentStudioPage';
import { MarketplacePage } from './pages/MarketplacePage';
import { SharePage } from './pages/SharePage';
import { UsersPage } from './pages/UsersPage';
import { AuthGuard } from './components/auth/AuthGuard';
import { AppLayout } from './components/layout/AppLayout';
import { APP_BASE, shouldUseHashRouter } from './utils/url';
import { Toaster } from '@/components/ui/sonner';

const ChatPage = lazy(() => import('./pages/ChatPage').then(m => ({ default: m.ChatPage })));
const TasksPage = lazy(() => import('./pages/TasksPage').then(m => ({ default: m.TasksPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const LoopsPage = lazy(() => import('./pages/LoopsPage').then(m => ({ default: m.LoopsPage })));
const GraphPage = lazy(() => import('./pages/GraphPage').then(m => ({ default: m.GraphPage })));
const TeamPage = lazy(() => import('./pages/TeamPage').then(m => ({ default: m.TeamPage })));
const WorkflowEditorPage = lazy(() => import('./pages/WorkflowEditorPage').then(m => ({ default: m.WorkflowEditorPage })));
const OpcPage = lazy(() => import('./pages/OpcPage').then(m => ({ default: m.OpcPage })));
const SupervisorPage = lazy(() => import('./pages/SupervisorPage').then(m => ({ default: m.SupervisorPage })));
const HarnessPage = lazy(() => import('./pages/HarnessPage').then(m => ({ default: m.HarnessPage })));
const SandboxPage = lazy(() => import('./pages/SandboxPage').then(m => ({ default: m.SandboxPage })));
const EnginesPage = lazy(() => import('./pages/EnginesPage').then(m => ({ default: m.EnginesPage })));
const BillingPage = lazy(() => import('./pages/BillingPage'));

export function App() {
  const Router = shouldUseHashRouter() ? HashRouter : BrowserRouter;

  return (
    <Router basename={APP_BASE === '/' ? undefined : APP_BASE}>
      <Toaster position="top-right" richColors />
      <Routes>
        {/* Public Routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/share/:token" element={<SharePage />} />
        <Route
          path="/setup/providers"
          element={
            <AuthGuard>
              <SetupProvidersPage />
            </AuthGuard>
          }
        />
        <Route
          path="/setup/channels"
          element={
            <AuthGuard>
              <SetupChannelsPage />
            </AuthGuard>
          }
        />

        {/* Protected Routes with Layout */}
        <Route
          element={
            <AuthGuard>
              <AppLayout />
            </AuthGuard>
          }
        >
          <Route path="/chat/:groupFolder?" element={<Suspense fallback={null}><ChatPage /></Suspense>} />
          <Route path="/groups" element={<Navigate to="/settings?tab=groups" replace />} />
          <Route path="/tasks" element={<Suspense fallback={null}><TasksPage /></Suspense>} />
          <Route path="/loops" element={<Suspense fallback={null}><LoopsPage /></Suspense>} />
          <Route path="/graphs" element={<Suspense fallback={null}><GraphPage /></Suspense>} />
          <Route path="/team" element={<Suspense fallback={null}><TeamPage /></Suspense>} />
          <Route path="/workflows" element={<Suspense fallback={null}><WorkflowEditorPage /></Suspense>} />
          <Route path="/workflows/:id" element={<Suspense fallback={null}><WorkflowEditorPage /></Suspense>} />
          <Route path="/opc" element={<Suspense fallback={null}><OpcPage /></Suspense>} />
          <Route path="/supervisor" element={<Suspense fallback={null}><SupervisorPage /></Suspense>} />
          <Route path="/harness" element={<Suspense fallback={null}><HarnessPage /></Suspense>} />
          <Route path="/monitor" element={<Navigate to="/settings?tab=monitor" replace />} />
          <Route path="/usage" element={<Navigate to="/settings?tab=usage" replace />} />
          <Route path="/billing" element={<Suspense fallback={null}><BillingPage /></Suspense>} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/mcp-servers" element={<McpServersPage />} />
          <Route path="/mcp-registry" element={<McpRegistryPage />} />
          <Route path="/plugins" element={<PluginsPage />} />
          <Route path="/agent-definitions" element={<AgentDefinitionsPage />} />
          <Route path="/agents" element={<AgentStudioPage />} />
          <Route path="/knowledge-bases" element={<KnowledgeBasesPage />} />
          <Route path="/marketplace" element={<MarketplacePage />} />
          <Route path="/sandbox" element={<Suspense fallback={null}><SandboxPage /></Suspense>} />
          <Route path="/engines" element={<Suspense fallback={null}><EnginesPage /></Suspense>} />
          <Route path="/settings" element={<Suspense fallback={null}><SettingsPage /></Suspense>} />
          <Route
            path="/users"
            element={
              <AuthGuard requiredAnyPermissions={['manage_users', 'manage_invites', 'view_audit_log']}>
                <UsersPage />
              </AuthGuard>
            }
          />
        </Route>

        {/* Default redirect — go through AuthGuard to detect setup state */}
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </Router>
  );
}
