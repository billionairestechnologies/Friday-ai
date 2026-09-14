import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./components/RequireAuth";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AdminGate } from "./pages/admin/AdminGate";
import { AuthPage } from "./pages/AuthPage";
import { ChatPage } from "./pages/ChatPage";

function Root() {
  const { user, loading } = useAuth();
  if (loading) return <div className="full-page-loader">Loading…</div>;
  return <Navigate to={user ? "/chat" : "/auth"} replace />;
}

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Root />} />
        <Route path="/auth" element={<AuthPage />} />
        <Route
          path="/chat"
          element={
            <RequireAuth>
              <ChatPage />
            </RequireAuth>
          }
        />
        {/* Hidden, standalone admin gate — deliberately not wrapped in RequireAuth or linked anywhere. */}
        <Route path="/admin" element={<AdminGate />} />
      </Routes>
    </AuthProvider>
  );
}
