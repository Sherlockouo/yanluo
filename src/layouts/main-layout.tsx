import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/layout/sidebar";
import { OnboardingGate } from "@/components/onboarding-gate";
import { SpotlightTour } from "@/components/spotlight-tour";

export function MainLayout() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-content w-full">
        <Outlet />
      </main>
      <OnboardingGate />
      <SpotlightTour />
    </div>
  );
}
