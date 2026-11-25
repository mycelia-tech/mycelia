import { NavLink } from "react-router-dom";
import {
  Activity,
  Clock,
  FileText,
  Images,
  Map,
  MessageSquare,
  Mic,
  Package,
  Search,
  Settings,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

const destinations = [
  { to: "/timeline", label: "Timeline", icon: Clock },
  { to: "/map", label: "Map", icon: Map },
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/objects", label: "Objects", icon: Package },
  { to: "/search", label: "Search", icon: Search },
  { to: "/media", label: "Media", icon: Images },
  { to: "/jobs", label: "Jobs", icon: Activity },
  { to: "/summaries", label: "AI History", icon: FileText },
  { to: "/audio/pipeline", label: "Pipeline", icon: Mic },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function MainNavigation(
  { runningCount = 0, onNavigate }: {
    runningCount?: number;
    onNavigate?: () => void;
  },
) {
  return (
    <nav
      aria-label="Main navigation"
      className="grid grid-cols-2 gap-1 sm:grid-cols-3 xl:flex xl:items-center xl:gap-0.5"
    >
      {destinations.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          onClick={onNavigate}
          data-testid={label === "Pipeline" ? "nav-pipeline" : undefined}
          className={({ isActive }) =>
            `flex min-h-10 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium xl:gap-1.5 xl:px-2 2xl:px-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${
              isActive
                ? "bg-accent text-accent-foreground ring-1 ring-inset ring-primary/30"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            }`}
        >
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
          {label}
          {label === "Jobs" && runningCount > 0 && (
            <Badge
              variant="secondary"
              className="rounded-full px-1.5 py-0 text-xs tabular-nums"
              aria-label={`${runningCount} jobs in progress`}
            >
              {runningCount}
            </Badge>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
