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
  Palette,
  ScrollText,
  Server,
  Settings,
  Sparkles,
  UserRound,
} from "lucide-react";

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

const settingsGroups = [
  { label: "Client Settings", tabs: clientSettings },
  { label: "Server Settings", tabs: serverSettings },
  { label: "Voice Identity", tabs: voiceIdentitySettings },
  { label: "Administration", tabs: administrationSettings },
];

const settingsTabs = settingsGroups.flatMap(({ tabs }) => tabs)
  .sort((a, b) => b.path.length - a.path.length);

const SettingsLayout = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activePath = settingsTabs.find((tab) =>
    pathname === tab.path || pathname.startsWith(tab.path + "/")
  )?.path ?? "/settings";

  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
      <div className="grid items-start gap-5 md:grid-cols-[12rem_minmax(0,1fr)] lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-7">
        <label className="space-y-1.5 text-sm font-semibold md:hidden">
          Settings section
          <select
            aria-label="Settings section"
            className="block min-h-10 w-full rounded-lg border border-input bg-card px-3 py-2 text-base font-normal"
            value={activePath}
            onChange={(event) => navigate(event.target.value)}
          >
            {settingsGroups.map(({ label, tabs }) => (
              <optgroup key={label} label={label}>
                {tabs.map((tab) => (
                  <option key={tab.path} value={tab.path}>{tab.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <nav
          aria-label="Settings navigation"
          className="hidden divide-y rounded-xl border bg-card md:block"
        >
          {settingsGroups.map(({ label, tabs }) => (
            <div key={label} className="p-2">
              <h2 className="px-2 pb-1.5 pt-1 text-xs font-semibold tracking-wide text-muted-foreground">
                {label}
              </h2>
              <ul className="space-y-0.5">
                {tabs.map(({ name, path, icon: Icon, description }) => (
                  <li key={path}>
                    <Link
                      to={path}
                      title={description}
                      aria-current={activePath === path ? "page" : undefined}
                      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm font-medium leading-5 text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:bg-primary/10 aria-[current=page]:font-semibold aria-[current=page]:text-primary"
                    >
                      <Icon aria-hidden="true" className="size-4 shrink-0" />
                      {name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="@container/settings min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
};

export default SettingsLayout;
