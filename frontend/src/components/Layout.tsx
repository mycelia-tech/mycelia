import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { getCurrentJWT } from "@/lib/auth";
import { useTheme } from "@/hooks/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { AudioPlayer } from "@/modules/audio/player.tsx";
import { useJobsListener } from "@/hooks/useJobsListener";
import { NotificationCenter } from "@/components/NotificationCenter";
import { GlobalAudioPlayerPopover } from "@/components/GlobalAudioPlayerPopover";
import { ChatNotificationCoordinator } from "@/components/chat/ChatNotificationCoordinator";
import { MainNavigation } from "@/components/MainNavigation";

const Layout = () => {
  useTheme();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const previousPath = useRef(location.pathname);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    setMenuOpen(false);
    if (previousPath.current !== location.pathname) {
      mainRef.current?.focus({ preventScroll: true });
    }
    previousPath.current = location.pathname;
  }, [location.pathname]);
  const { sessionStatus, apiEndpoint, clientId } = useSettingsStore();
  useEffect(() => {
    if (sessionStatus === "unknown") void getCurrentJWT();
  }, [sessionStatus, apiEndpoint]);
  const { runningCount } = useJobsListener({
    statuses: ["active", "waiting", "delayed"],
    limit: 200,
  });

  if (sessionStatus === "unknown") {
    return <main role="status" className="p-6">Checking your session…</main>;
  }
  if (sessionStatus === "anonymous") {
    return <Navigate to="/setup" replace />;
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:p-3 focus:outline"
        >
          Skip to content
        </a>
        <header className="border-b">
          <div className="mx-auto px-4 md:container">
            <div className="flex min-h-16 items-center justify-between gap-3">
              <Link to="/" className="text-xl font-bold">Mycelia</Link>
              <div className="flex items-center gap-2">
                <NotificationCenter />
                <GlobalAudioPlayerPopover />
                <Button
                  className="xl:hidden"
                  variant="outline"
                  aria-expanded={menuOpen}
                  aria-controls="main-navigation"
                  onClick={() => setMenuOpen(!menuOpen)}
                >
                  <Menu aria-hidden="true" className="mr-2 h-4 w-4" />Menu
                </Button>
              </div>
            </div>
            <div
              id="main-navigation"
              className={`${menuOpen ? "block" : "hidden"} pb-3 xl:block`}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setMenuOpen(false);
                  document.querySelector<HTMLButtonElement>(
                    '[aria-controls="main-navigation"]',
                  )?.focus();
                }
              }}
            >
              <MainNavigation
                runningCount={runningCount}
                onNavigate={() => setMenuOpen(false)}
              />
            </div>
          </div>
        </header>
        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="mx-auto px-3 py-6 outline-none md:container md:px-4"
        >
          <Outlet key={`${apiEndpoint}:${clientId}`} />
        </main>
      </div>
      <AudioPlayer />
      <ChatNotificationCoordinator />
    </TooltipProvider>
  );
};

export default Layout;
