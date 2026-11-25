import { Link, Navigate, Outlet, useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { getCurrentJWT } from "@/lib/auth";
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
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const dismissOutside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !headerRef.current?.contains(event.target)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
    };
  }, [menuOpen]);
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
      <div className="workspace min-h-dvh bg-background">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:p-3 focus:outline"
        >
          Skip to content
        </a>
        <header
          ref={headerRef}
          className="relative z-40 border-b bg-card"
          onKeyDown={(event) => {
            if (menuOpen && event.key === "Escape") {
              setMenuOpen(false);
              menuButtonRef.current?.focus();
            }
          }}
        >
          <div className="mx-auto flex h-[calc(4rem-1px)] max-w-[100rem] items-center gap-2 px-3 sm:gap-4 sm:px-5 lg:px-7">
            <Link
              to="/"
              className="mr-auto inline-flex shrink-0 items-center gap-2 rounded-md font-serif text-2xl font-semibold tracking-tight xl:mr-0"
            >
              <img src="/mushroom.png" alt="" width="28" height="28" />
              Mycelia
            </Link>
            <div className="flex shrink-0 items-center gap-1 xl:order-last xl:ml-auto xl:border-l xl:pl-3">
              <NotificationCenter />
              <GlobalAudioPlayerPopover />
              <Button
                ref={menuButtonRef}
                className="px-2.5 sm:px-4 xl:hidden"
                variant="outline"
                aria-expanded={menuOpen}
                aria-controls="main-navigation"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                {menuOpen
                  ? <X aria-hidden="true" />
                  : <Menu aria-hidden="true" />}Menu
              </Button>
            </div>
            <div
              id="main-navigation"
              className={`${
                menuOpen ? "block" : "hidden"
              } absolute inset-x-0 top-full max-h-[calc(100dvh-4rem)] overflow-auto border-b bg-card p-3 shadow-md xl:static xl:block xl:max-h-none xl:overflow-visible xl:border-0 xl:p-0 xl:shadow-none`}
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
          className="mx-auto min-w-0 max-w-[100rem] px-3 py-[var(--page-padding-y)] outline-none sm:px-5 lg:px-7"
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
