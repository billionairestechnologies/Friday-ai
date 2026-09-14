import { useAuth } from "../../context/AuthContext";
import { AdminLoginPage } from "./AdminLoginPage";
import { AdminPage } from "./AdminPage";

// /admin is intentionally not wrapped by the regular RequireAuth flow and isn't linked
// from anywhere — it's a standalone hidden gate with its own login, independent of /auth.
export function AdminGate() {
  const { user, loading, logout } = useAuth();

  if (loading) return <div className="full-page-loader">Loading…</div>;
  if (!user) return <AdminLoginPage />;
  if (user.role !== "admin") {
    return <AdminLoginPage deniedMessage="This account doesn't have admin access." />;
  }

  return <AdminPage onLogout={logout} />;
}
