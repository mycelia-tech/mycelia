# Project Overview

This is the standalone React frontend for Mycelia, a self-hosted AI memory and timeline system. The frontend is a Single Page Application (SPA) built with Deno, React, TypeScript, Vite, and D3.js for interactive timeline visualization.

## Development Commands

```bash
# Install dependencies (Deno handles this automatically)
deno install

# Start development server (http://localhost:3001)
deno task dev


# Build for production
deno task build

# Preview production build
deno task preview

# Type check without emitting files
deno task type-check

# Lint code
deno lint
```

## Architecture

### Tech Stack
- **Deno** for runtime and package management
- **React 18** with TypeScript
- **React Router v7** for client-side routing
- **Vite** with @deno/vite-plugin for build tooling and dev server
- **Zustand** for state management
- **D3.js** for timeline visualization with zoom/pan
- **Tailwind CSS v4** for styling
- **Radix UI** for accessible component primitives
- **Zod** for runtime validation
- **React Hook Form** with Zod resolvers for form handling

### Project Structure

```
src/
├── components/           # Reusable React components
│   ├── ui/              # Radix UI-based primitive components
│   ├── ai-elements/     # AI chat interface components (messages, reasoning, artifacts)
│   ├── audio/           # Audio recording UI (visualizer, controls, status)
│   ├── dialogs/         # Modal dialogs (SummarizeDialog)
│   ├── forms/           # Form components (FormField, EntityEditSheet)
│   ├── timeline/        # Timeline visualization components
│   ├── Layout.tsx       # Main app layout
│   └── SettingsLayout.tsx  # Settings tab navigation
├── core/                # Core type definitions (Layer, Tool, Config)
├── hooks/               # Custom React hooks
│   ├── useTimeline.ts   # Timeline zoom/pan with D3
│   ├── useTheme.ts      # Dark mode management
│   ├── useAudioRecording.ts  # Audio recording logic
│   ├── useJobsListener.ts    # Real-time job updates
│   ├── useObjectQueries.ts   # Object data fetching
│   └── useWebSocket.ts       # WebSocket connection
├── lib/                 # Utility functions
│   ├── api.ts           # API client with OAuth2 integration
│   ├── auth.ts          # JWT token exchange
│   ├── formatTime.ts    # Time formatting utilities
│   ├── jobs.ts          # Job queue utilities
│   ├── llm.ts           # LLM API helpers
│   ├── websocket.ts     # WebSocket client
│   └── utils.ts         # General helper functions
├── modules/             # Feature modules (Layer system)
│   ├── audio/           # Audio playback and transcription display
│   ├── histogram/       # Histogram visualization layer
│   ├── map/             # Map visualization layer
│   ├── messenger/       # Messenger integration (Telegram, etc.)
│   ├── objects/         # Object management layer
│   ├── ranges/          # Range utilities
│   └── time/            # Time formatting (SI units, Gregorian)
├── pages/               # Route page components
│   ├── HomePage.tsx     # Main landing page
│   ├── TimelinePage.tsx # Timeline visualization
│   ├── ChatPage.tsx     # AI chat interface
│   ├── ObjectsPage.tsx  # Objects list view
│   ├── JobsPage.tsx     # Background jobs management
│   ├── MessengerPage.tsx # Messenger integration
│   └── settings/        # Settings sub-pages
│       ├── GeneralSettingsPage.tsx     # Appearance & time settings
│       ├── APISettingsPage.tsx         # API configuration
│       ├── APIKeysPage.tsx             # API keys management
│       ├── InferenceSettingsPage.tsx   # Inference settings
│       ├── ProvidersSettingsPage.tsx   # LLM providers management
│       ├── CreateLLMPage.tsx           # Add new LLM model
│       ├── PromptsPage.tsx             # Prompts management
│       ├── PromptDetailPage.tsx        # Edit prompt
│       ├── FeatureFlagsPage.tsx        # Feature flags
│       └── AccessLogPage.tsx           # Access log viewer
├── stores/              # Zustand state stores
│   ├── timelineRange.ts         # Timeline date range with URL sync
│   ├── settingsStore.ts         # App settings (API endpoint, credentials)
│   ├── messengerStore.ts        # Messenger state
│   ├── objectSelectionStore.ts  # Object selection state
│   ├── timelineSelectionStore.ts # Timeline selection state
│   └── topicsStore.ts           # Topics state
└── types/               # TypeScript type definitions
    ├── llm.ts           # LLM model types and schemas
    ├── objects.ts       # Object types
    ├── timeline.ts      # Timeline types
    ├── events.ts        # Event types
    ├── people.ts        # People types
    ├── config.ts        # Configuration types
    └── icon.ts          # Icon types
```

### Import Conventions

Use `@/` alias for all imports (configured in `deno.json` import map):
```typescript
import { Component } from '@/components/Component'
import { useTimeline } from '@/hooks/useTimeline'
import type { TimelineItem } from '@/types/timeline'
```

Dependencies are managed through Deno's import map in `deno.json`:
- npm packages are prefixed with `npm:` in the import map
- Standard library packages use `jsr:@std/*`
- The `@/` alias points to `./src/`

### Form Handling

**React Hook Form with Zod:**
- Use `useForm` hook with `zodResolver` for form validation
- Define Zod schemas for runtime validation
- Handle form state, errors, and submission

```typescript
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email'),
});

const form = useForm({
  resolver: zodResolver(schema),
  defaultValues: { name: '', email: '' }
});
```

### UI Component Conventions

**Date and Time Input:**
- Use `DateRangePicker` from `@/components/DateRangePicker` whenever a user
  chooses a start/end range. It provides one combined calendar selection,
  month/year dropdowns, optional minute/second precision, configured-timezone
  conversion, validation, explicit Start/End boundary editing, a scroll-contained
  dialog, and optional audio-density fine tuning.
- Use `DateTimePicker` from `@/components/ui/datetime-picker` for a single
  instant, or `precision="date"` for a single calendar boundary such as an
  existing end-only filter. Date-only Apply normalizes to zoned midnight.
- Never assemble range controls from separate native `date`, `time`, or
  `datetime-local` inputs.
- Seconds are opt-in with `precision="second"`; ordinary ranges default to
  minute precision. Date-only filters use `precision="date"`.

```typescript
import { DateRangePicker } from '@/components/DateRangePicker';

<DateRangePicker
  value={{ start, end }}
  onChange={(range) => {
    setStart(range.start);
    if (range.end) setEnd(range.end);
  }}
  showAudioTimeline
/>
```

### Deno-Specific Patterns

**Import Maps:**
- All dependencies defined in `deno.json` imports
- Never use `npm:`/`jsr:` prefixes, it's resolved automatically by Deno
- Local imports use `@/` alias

**Development Workflow:**
- Use `deno test -A --no-check' to run tests
- Use `deno install --npm <package-name>` to install npm packages
