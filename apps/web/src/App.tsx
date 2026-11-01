import { useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth';
import { ToastProvider } from './components/ui';
import { AppShell } from './components/AppShell';
import { ConnectPage } from './pages/ConnectPage';
import { OverviewPage } from './pages/OverviewPage';
import { ModelsPage } from './pages/ModelsPage';
import { ModelDetailPage } from './pages/ModelDetailPage';
import { ScenariosPage } from './pages/ScenariosPage';
import { ScenarioDetailPage } from './pages/ScenarioDetailPage';
import { JobsPage } from './pages/JobsPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { ReviewsPage } from './pages/ReviewsPage';
import { ReviewDetailPage } from './pages/ReviewDetailPage';
import { PlansPage } from './pages/PlansPage';
import { PlanDetailPage } from './pages/PlanDetailPage';
import { RulesPage } from './pages/RulesPage';
import { RuleDetailPage } from './pages/RuleDetailPage';
import { VariancePage } from './pages/VariancePage';
import { AuditPage } from './pages/AuditPage';
import { NotFoundPage } from './pages/NotFoundPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

function RequireAuth() {
  const { token } = useAuth();
  return token ? <Outlet /> : <Navigate to="/connect" replace />;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <ScrollToTop />
            <Routes>
              <Route path="/connect" element={<ConnectPage mode="connect" />} />
              <Route element={<RequireAuth />}>
                <Route element={<AppShell />}>
                  <Route index element={<OverviewPage />} />
                  <Route path="models" element={<ModelsPage />} />
                  <Route path="models/:modelId" element={<ModelDetailPage />} />
                  <Route path="scenarios" element={<ScenariosPage />} />
                  <Route path="scenarios/:scenarioId" element={<ScenarioDetailPage />} />
                  <Route path="jobs" element={<JobsPage />} />
                  <Route path="jobs/:jobId" element={<JobDetailPage />} />
                  <Route path="reviews" element={<ReviewsPage />} />
                  <Route path="reviews/:submissionId" element={<ReviewDetailPage />} />
                  <Route path="plans" element={<PlansPage />} />
                  <Route path="plans/:planId" element={<PlanDetailPage />} />
                  <Route path="rules" element={<RulesPage />} />
                  <Route path="rules/:ruleId" element={<RuleDetailPage />} />
                  <Route path="variance" element={<VariancePage />} />
                  <Route path="audit" element={<AuditPage />} />
                  <Route path="connection" element={<ConnectPage mode="connection" />} />
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Route>
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
