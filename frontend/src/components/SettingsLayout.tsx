import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  AudioLines,
  Cloud,
  Cog,
  Database,
  FileSearch,
  Flag,
  Key,
  Map as MapIcon,
  Monitor,
  Palette,
  ScrollText,
  Server,
  Settings,
  Shield,
  Sparkles,
  UserRound,
} from "lucide-react";

const SettingsLayout = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const clientSettings = [
    {
      name: "General",
      path: "/settings",
      icon: Palette,
      description: "Appearance and time format",
    },
    {
      name: "API",
      path: "/settings/api",
      icon: Key,
      description: "API endpoint, credentials & keys",
    },
  ];

  const serverSettings = [
    {
      name: "Inference",
      path: "/settings/inference",
      icon: Server,
      description: "Configure LLM providers and model routing",
    },
    {
      name: "Speech-to-text",
      path: "/settings/speech-to-text",
      icon: AudioLines,
      description: "Manage local and remote STT servers",
    },
    {
      name: "Diarization",
      path: "/settings/diarization",
      icon: AudioLines,
      description: "Manage local and remote speaker services",
    },
    {
      name: "Prompts",
      path: "/settings/prompts",
      icon: ScrollText,
      description: "Manage prompt templates",
    },
    {
      name: "Configuration",
      path: "/settings/config",
      icon: Settings,
      description: "Manage server configuration",
    },
    {
      name: "Workers",
      path: "/settings/workers",
      icon: Cog,
      description: "Configure background job workers",
    },
    {
      name: "Maps",
      path: "/settings/maps",
      icon: MapIcon,
      description: "Places database, GPS imports and map preferences",
    },
    {
      name: "Photo analysis",
      path: "/settings/photo-analysis",
      icon: Sparkles,
      description: "Vision connections and photo models",
    },
    {
      name: "Google Cloud (optional)",
      path: "/settings/google-cloud",
      icon: Cloud,
      description: "Optional Google services and credit guard",
    },
    {
      name: "Knowledge / RAG",
      path: "/settings/knowledge",
      icon: Database,
      description: "Inspect, update and rebuild the Qdrant projection",
    },
  ];

  const voiceIdentitySettings = [
    {
      name: "Profiles & samples",
      path: "/settings/voice-profiles",
      icon: UserRound,
      description: "Enroll Sky and manage voice samples",
    },
    {
      name: "Review & calibration",
      path: "/settings/voice-identity",
      icon: Sparkles,
      description: "Label uncertain voices and validate thresholds",
    },
    {
      name: "Operations & generations",
      path: "/settings/voice-identity/operations",
      icon: AudioLines,
      description: "Classify history or build isolated diarization runs",
    },
  ];

  const administrationSettings = [
    {
      name: "Access Log",
      path: "/settings/access-log",
      icon: FileSearch,
      description: "View and audit access logs",
    },
    {
      name: "Feature Flags",
      path: "/settings/feature-flags",
      icon: Flag,
      description: "Enable or disable server features",
    },
  ];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Settings</h1>
      </div>

      <div className="flex flex-col gap-6 md:flex-row">
        <label className="space-y-2 text-sm font-medium md:hidden">
          Settings section
          <select
            aria-label="Settings section"
            className="block w-full rounded-md border bg-background p-3"
            value={[
              ...clientSettings,
              ...serverSettings,
              ...voiceIdentitySettings,
              ...administrationSettings,
            ].filter((tab) =>
              location.pathname === tab.path ||
              (tab.path !== "/settings" &&
                location.pathname.startsWith(tab.path + "/"))
            ).sort((a, b) => b.path.length - a.path.length)[0]?.path ??
              "/settings"}
            onChange={(event) => navigate(event.target.value)}
          >
            {[
              ...clientSettings,
              ...serverSettings,
              ...voiceIdentitySettings,
              ...administrationSettings,
            ].map((tab) => (
              <option key={tab.path} value={tab.path}>{tab.name}</option>
            ))}
          </select>
        </label>
        {/* Sidebar Navigation */}
        <nav
          aria-label="Settings navigation"
          className="hidden w-64 shrink-0 space-y-6 md:block"
        >
          {/* Client Settings Section */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <Monitor className="w-3 h-3" />
              Client Settings
            </div>
            <div className="space-y-1">
              {clientSettings.map((tab) => {
                const Icon = tab.icon;
                const isActive = location.pathname === tab.path ||
                  (tab.path === "/settings" &&
                    location.pathname === "/settings");

                return (
                  <Link
                    key={tab.path}
                    aria-current={isActive ? "page" : undefined}
                    to={tab.path}
                    className={`flex items-start gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-medium">{tab.name}</div>
                      <div className="text-xs mt-0.5">
                        {tab.description}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Server Settings Section */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <Database className="w-3 h-3" />
              Server Settings
            </div>
            <div className="space-y-1">
              {serverSettings.map((tab) => {
                const Icon = tab.icon;
                const isActive = location.pathname === tab.path ||
                  location.pathname.startsWith(tab.path);

                return (
                  <Link
                    key={tab.path}
                    aria-current={isActive ? "page" : undefined}
                    to={tab.path}
                    className={`flex items-start gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-medium">{tab.name}</div>
                      <div className="text-xs mt-0.5">
                        {tab.description}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <UserRound className="w-3 h-3" />
              Voice Identity
            </div>
            <div className="space-y-1">
              {voiceIdentitySettings.map((tab) => {
                const Icon = tab.icon;
                const isActive = location.pathname === tab.path;

                return (
                  <Link
                    key={tab.path}
                    aria-current={isActive ? "page" : undefined}
                    to={tab.path}
                    className={`flex items-start gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-medium">{tab.name}</div>
                      <div className="text-xs mt-0.5">
                        {tab.description}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Administration Section */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              <Shield className="w-3 h-3" />
              Administration
            </div>
            <div className="space-y-1">
              {administrationSettings.map((tab) => {
                const Icon = tab.icon;
                const isActive = location.pathname === tab.path ||
                  location.pathname.startsWith(tab.path);

                return (
                  <Link
                    key={tab.path}
                    aria-current={isActive ? "page" : undefined}
                    to={tab.path}
                    className={`flex items-start gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="font-medium">{tab.name}</div>
                      <div className="text-xs mt-0.5">
                        {tab.description}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </nav>

        {/* Main Content */}
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
};

export default SettingsLayout;
