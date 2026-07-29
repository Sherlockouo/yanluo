import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/layout/sidebar";
import { OnboardingGate } from "@/components/onboarding-gate";
import { SpotlightTour } from "@/components/spotlight-tour";
import { FirstRunIntro } from "@/components/first-run-intro";

export function MainLayout() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-content w-full">
        <Outlet />
      </main>
      <FirstRunIntro />
      <OnboardingGate />
      <SpotlightTour />
    </div>
  );
}
