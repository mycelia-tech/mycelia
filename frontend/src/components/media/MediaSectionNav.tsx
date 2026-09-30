import { NavLink } from "react-router-dom";
import { Images, Upload } from "lucide-react";
import { cn } from "@/lib/utils";

const sections = [
  {
    to: "/media/analysis",
    label: "Photo analysis",
    icon: Images,
  },
  {
    to: "/media",
    label: "Import & library",
    icon: Upload,
  },
] as const;

export function MediaSectionNav() {
  return (
    <nav
      aria-label="Media sections"
      className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1"
    >
      {sections.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/media"}
          className={({ isActive }) =>
            cn(
              "inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
            )}
        >
          <Icon className="h-4 w-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
