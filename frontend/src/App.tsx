import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./components/RequireAuth";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { AdminPage } from "./pages/admin/AdminPage";
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
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <AdminPage />
            </RequireAuth>
          }
        />
      </Routes>
    </AuthProvider>
  );
}
