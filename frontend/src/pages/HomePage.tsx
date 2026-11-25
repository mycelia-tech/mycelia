import { Form, Link } from "react-router-dom";
import {
  ArrowRight,
  AudioLines,
  BookOpen,
  ChevronRight,
  Clock,
  Download,
  FileClock,
  FileText,
  FolderOpen,
  Images,
  Layers,
  type LucideIcon,
  Map,
  MessageCircle,
  MessagesSquare,
  Mic,
  Network,
  Search,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const sections: {
  title: string;
  icon: LucideIcon;
  links: { to: string; label: string; detail?: string; icon: LucideIcon }[];
}[] = [
  {
    title: "Explore",
    icon: BookOpen,
    links: [
      {
        to: "/timeline",
        label: "Timeline",
        detail: "Browse memories by date",
        icon: Clock,
      },
      {
        to: "/map",
        label: "Map",
        detail: "Explore places and routes",
        icon: Map,
      },
      {
        to: "/media",
        label: "Media",
        detail: "Browse photos and files",
        icon: Images,
      },
      {
        to: "/objects",
        label: "Objects",
        detail: "Find people, topics and events",
        icon: Layers,
      },
    ],
  },
  {
    title: "Messages & AI",
    icon: MessagesSquare,
    links: [
      {
        to: "/chat",
        label: "Chat",
        detail: "Ask your memory assistant",
        icon: MessageCircle,
      },
      {
        to: "/conversations",
        label: "Conversations",
        detail: "Read recorded conversations",
        icon: MessagesSquare,
      },
      {
        to: "/messaging",
        label: "Messenger",
        detail: "Browse imported messages",
        icon: Network,
      },
      {
        to: "/summaries",
        label: "AI History",
        detail: "Review summaries and outputs",
        icon: FileClock,
      },
    ],
  },
  {
    title: "Audio & transcripts",
    icon: AudioLines,
    links: [
      { to: "/audio", label: "Audio Player", icon: AudioLines },
      { to: "/audio/record", label: "Record", icon: Mic },
      { to: "/audio/source_files", label: "Source Files", icon: FolderOpen },
      { to: "/transcript", label: "Raw Transcript", icon: FileText },
      { to: "/audio/export", label: "Export", icon: Download },
      { to: "/audio/pipeline", label: "Pipeline", icon: Workflow },
    ],
  },
];

export default function HomePage() {
  return (
    <div className="mx-auto max-w-[80rem] space-y-5">
      <section className="relative isolate overflow-hidden rounded-xl bg-[#14241b] px-5 py-6 text-white sm:px-8 sm:py-8">
        <img
          src="/forest-canopy.webp"
          alt=""
          fetchPriority="high"
          className="pointer-events-none absolute inset-0 -z-20 size-full object-cover object-right"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-linear-to-r from-[#0c1b12]/95 via-[#0c1b12]/70 to-[#0c1b12]/30 sm:via-[#0c1b12]/30 sm:to-transparent"
        />
        <h1 className="font-serif text-[clamp(2rem,4vw,3rem)] leading-tight tracking-tight">
          Welcome to Mycelia
        </h1>
        <p className="mt-1 text-base text-white/90">
          Find a moment in your personal archive.
        </p>
        <Form
          role="search"
          method="get"
          action="/search"
          className="mt-5 flex w-full max-w-lg items-center gap-2 rounded-lg bg-card p-1.5 pl-3 text-card-foreground"
        >
          <Search
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <label htmlFor="home-search" className="sr-only">
            Search your memories
          </label>
          <input
            id="home-search"
            type="search"
            name="q"
            placeholder="Find a memory…"
            className="h-9 min-w-0 flex-1 bg-transparent text-base placeholder:text-muted-foreground"
          />
          <Button type="submit" aria-label="Search memories">
            Search <ArrowRight aria-hidden="true" className="hidden sm:block" />
          </Button>
        </Form>
      </section>

      <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
        {sections.map(({ title, icon: SectionIcon, links }) => (
          <section
            key={title}
            className="overflow-hidden rounded-xl border bg-card shadow-xs"
          >
            <div className="flex items-center gap-3 border-b bg-muted/50 px-4 py-3">
              <SectionIcon aria-hidden="true" className="size-5 text-primary" />
              <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            </div>
            <ul className="divide-y px-3">
              {links.map(({ to, label, icon: Icon, detail }) => (
                <li key={to}>
                  <Link
                    to={to}
                    className="group my-0.5 flex min-h-11 items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent"
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-4 shrink-0 text-primary"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium leading-snug">
                        {label}
                      </span>
                      {detail && (
                        <span className="block text-sm text-muted-foreground">
                          {detail}
                        </span>
                      )}
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground group-hover:text-primary"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
