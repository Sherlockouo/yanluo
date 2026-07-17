import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/layout/sidebar";

export function MainLayout() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-content w-full">
        <Outlet />
      </main>
    </div>
  );
}
