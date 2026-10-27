<!-- historical-plan -->
# Historical Developer Experience Roadmap (2025)

This document is a preserved proposal, not a statement of implemented features.
See [the current documentation index](../README.md).

**Version**: 1.0
**Date**: 2025-11-27
**Status**: Historical proposal (the original document was marked Complete)

---

## Overview

This documentation package provides a comprehensive plan for transforming Mycelia's developer experience from its current state to a **frictionless, sovereignty-first onboarding system**.

**Core Vision**: `clone → run → test immediately`

---

## Documents in This Package

### 1. [Developer Experience Roadmap](../DX_ROADMAP.md)
**Purpose**: Strategic roadmap for DX improvements over 16 weeks

**Contents**:
- Current state analysis
- Vision and target state
- 6 detailed implementation phases:
  - Phase 0: Foundation (Docker Compose, auto-init)
  - Phase 1: Onboarding Experience (setup wizard)
  - Phase 2: Inference Configuration (managed vs. self-hosted)
  - Phase 3: LLM Management (model selection, providers)
  - Phase 4: Privacy & Transparency (usage tracking, privacy policy)
  - Phase 5: Artifacts System (processing, templates, re-processing)
  - Phase 6: Advanced Features (batch ops, backups, sharing)
- Timeline: 16 weeks total
- Success metrics for each phase
- Risk mitigation strategies

**Key Outcomes**:
- Single-command startup (`docker compose up`)
- Complete working environment in < 5 minutes
- Zero manual configuration required
- Interactive setup wizard (web + CLI)

---

### 2. [Task Breakdown](../TASK_BREAKDOWN.md)
**Purpose**: Detailed implementation tasks for development team

**Contents**:
- 60+ actionable tasks organized by:
  - Component area (Backend, Frontend, Python, DevOps, Documentation)
  - Phase and priority (P0-P3)
  - Estimated effort (in days)
  - Dependencies
- Acceptance criteria for each task
- Team requirements and composition
- Tracking and reporting guidelines

**Task Summary**:
- **Backend**: ~42 days (8.5 weeks)
- **Frontend**: ~38 days (7.5 weeks)
- **Python**: ~3 days
- **DevOps**: ~29 days (6 weeks)
- **Documentation**: ~11 days (2 weeks)

**Use Case**: Sprint planning, task assignment, progress tracking

---

### 3. [User Onboarding Flow](../ONBOARDING_FLOW.md)
**Purpose**: Complete user journey from first clone to productive use

**Contents**:
- Visual decision tree diagram (ASCII art)
- Step-by-step wizard flow (6 steps):
  1. Welcome & overview
  2. Inference server choice (Managed vs. Self-hosted)
  3. AI model configuration (Defaults vs. Custom vs. Local)
  4. Audio source setup (optional)
  5. Sample data import (optional)
  6. Setup complete & summary
- Alternative paths:
  - Power user (skip wizard, use defaults)
  - CLI-only setup
  - Re-run setup
- Edge case handling and error flows
- Post-setup user journeys
- Privacy decision points at each step
- Measurement and success criteria

**Key Features**:
- Sensible defaults at every step
- Clear privacy communication
- Flexible configuration
- Skip or configure later options

---

### 4. [Processing System & Artifacts](../PROCESSING_AND_ARTIFACTS.md)
**Purpose**: Detailed explanation of data processing pipeline and artifact management

**Contents**:
- **Processing Pipeline**:
  - Current 5-stage pipeline (discovery → STT → conversation extraction)
  - New user-directed processing layer
  - Job queue architecture (BullMQ)
- **Processing Types & Templates**:
  - 5 built-in templates:
    1. Summary (daily/weekly/monthly overviews)
    2. Task Extraction (TODO items from meetings)
    3. Meeting Notes (structured business notes)
    4. Therapy/Reflection (psychological session analysis)
    5. Custom (user-defined processing)
  - Template structure (YAML-based)
  - Variable substitution system
- **Artifacts System**:
  - Data model and schema
  - Lifecycle management
  - Organization (tags, visibility, versioning)
  - Operations (create, read, update, delete, re-process)
- **User Workflows**:
  - Daily summary creation
  - Task extraction from meetings
  - Re-processing with better models
  - Custom analysis
  - Automated weekly reviews
- **Technical Implementation**:
  - Job queue configuration
  - Template rendering engine
  - LLM integration
  - Data fetching and storage
- **Privacy & Transparency**:
  - What is tracked (usage metrics only)
  - What is NEVER tracked (content, transcripts, prompts)
  - Data flow diagrams
  - Usage dashboard design

**Key Innovation**: Modular, auditable, reusable processing with complete user control

---

## Quick Navigation

### For Project Managers
- Start with: [DX_ROADMAP.md](../DX_ROADMAP.md)
- Focus on: Timeline, phases, success metrics
- Use for: Strategic planning, resource allocation

### For Engineering Leads
- Start with: [TASK_BREAKDOWN.md](../TASK_BREAKDOWN.md)
- Focus on: Task dependencies, effort estimates, technical specs
- Use for: Sprint planning, team assignments

### For Product Designers
- Start with: [ONBOARDING_FLOW.md](../ONBOARDING_FLOW.md)
- Focus on: User journeys, decision points, UI flows
- Use for: Wireframes, prototypes, user testing

### For Backend Engineers
- Start with: [PROCESSING_AND_ARTIFACTS.md](../PROCESSING_AND_ARTIFACTS.md)
- Focus on: Architecture, data models, API endpoints
- Use for: Implementation details, schema design

### For DevOps Engineers
- Start with: [DX_ROADMAP.md](../DX_ROADMAP.md) Phase 0
- Focus on: Docker Compose, auto-initialization, health checks
- Use for: Infrastructure setup, deployment automation

---

## Implementation Approach

### Recommended Order
1. **Phase 0 (Weeks 1-2)**: Foundation - Docker Compose consolidation
2. **Phase 1 (Weeks 3-4)**: Onboarding - Setup wizard (web + CLI)
3. **Phase 2 (Weeks 5-6)**: Inference - Managed and self-hosted options
4. **Phase 3 (Weeks 7-8)**: LLM - Model management and selection
5. **Phase 4 (Weeks 9-10)**: Privacy - Usage tracking and transparency
6. **Phase 5 (Weeks 11-13)**: Artifacts - Processing system and templates
7. **Phase 6 (Weeks 14-16)**: Advanced - Batch ops, backups, polish

### Parallel Workstreams
- **Infrastructure** (OPS tasks) can run independently
- **Frontend** and **Backend** tasks often have dependencies
- **Documentation** should be written alongside implementation

### Milestones
- **Week 2**: Docker Compose fully functional
- **Week 4**: Setup wizard complete
- **Week 8**: LLM and inference fully configurable
- **Week 10**: Privacy policy and usage tracking live
- **Week 13**: Artifacts system fully functional
- **Week 16**: All features complete, polished, documented

---

## Key Principles

### 1. Frictionless by Default
- Single command to start: `docker compose up`
- Auto-initialization of all services
- Sensible defaults that work out of box
- Optional configuration for advanced users

### 2. Sovereign by Design
- Privacy-first architecture
- Self-hosting as first-class option
- Complete user control over data and processing
- Transparent data flow at every step

### 3. Modular and Extensible
- Template-based processing system
- Pluggable LLM providers
- Custom processing templates
- Resource-based backend architecture

### 4. Transparent and Auditable
- Clear communication of what is tracked
- Usage dashboard with full visibility
- Artifact metadata includes full processing details
- Privacy policy linked at every step

---

## Success Metrics

### Developer Experience
- ✅ Time to running system: < 5 minutes
- ✅ Setup wizard completion rate: > 80%
- ✅ Zero manual configuration required
- ✅ Documentation rated 4+/5 by users

### User Onboarding
- ✅ First artifact created: < 10 minutes after setup
- ✅ Self-hosted setup: < 15 minutes
- ✅ Support tickets for onboarding: < 10%

### System Performance
- ✅ Frontend load time: < 2 seconds
- ✅ Timeline rendering (1 month): < 1 second
- ✅ Processing job completion: < 2 minutes (avg)
- ✅ API response time (p95): < 200ms

### Privacy & Trust
- ✅ Privacy policy published and accessible
- ✅ Zero content logging (verified)
- ✅ Usage dashboard shows accurate data
- ✅ Data export functional

---

## Repository Structure

```
mycelia/
├── backend/                    # Deno TypeScript backend
│   ├── app/
│   │   ├── lib/
│   │   │   ├── auth/           # Authentication system
│   │   │   ├── llm/            # LLM integration
│   │   │   ├── mongo/          # Database layer
│   │   │   ├── processors/     # Processing jobs (NEW)
│   │   │   └── resources/      # Resource system
│   │   ├── routes/             # API endpoints
│   │   └── templates/          # Processing templates (NEW)
│   ├── migrations/             # Database migrations (NEW)
│   └── Dockerfile              # Backend container (NEW)
├── frontend/                   # React frontend
│   ├── src/
│   │   ├── pages/
│   │   │   ├── SetupWizardPage.tsx        # NEW
│   │   │   ├── ArtifactsPage.tsx          # NEW
│   │   │   ├── ProcessingRequestPage.tsx  # NEW
│   │   │   └── settings/
│   │   │       ├── InferenceSettingsPage.tsx  # NEW
│   │   │       ├── UsagePage.tsx              # NEW
│   │   │       └── PrivacyPage.tsx            # NEW
│   │   └── components/         # UI components
│   └── Dockerfile              # Frontend container (NEW)
├── python/                     # Processing pipeline
│   ├── daemon.py               # Audio ingestion
│   ├── stt.py                  # Speech-to-text
│   ├── convos/                 # Conversation extraction
│   ├── whisper_server/         # Whisper STT server
│   ├── diarization/            # Speaker diarization (NEW)
│   └── Dockerfile              # Python container (NEW)
├── scripts/                    # Setup and utility scripts
│   ├── init-db.sh              # Database initialization (NEW)
│   ├── generate-keys.sh        # API key generation (NEW)
│   ├── setup-wizard.ts         # CLI setup wizard (NEW)
│   ├── backup.sh               # Backup system (NEW)
│   └── restore.sh              # Restore system (NEW)
├── docs/                       # Documentation
│   ├── README.md               # This file
│   ├── DX_ROADMAP.md           # Roadmap
│   ├── TASK_BREAKDOWN.md       # Task list
│   ├── ONBOARDING_FLOW.md      # User journeys
│   ├── PROCESSING_AND_ARTIFACTS.md  # Processing system
│   ├── QUICKSTART.md           # NEW
│   ├── ARCHITECTURE.md         # NEW
│   ├── DOCKER.md               # NEW
│   ├── PRIVACY.md              # NEW
│   ├── SELF_HOSTING.md         # NEW
│   └── MODEL_SELECTION.md      # NEW
├── docker-compose.yml          # Main stack (ENHANCED)
├── docker-compose.inference.yml  # Inference servers (NEW)
├── .env.example                # Unified environment template (NEW)
└── README.md                   # Main README (ENHANCED)
```

---

## Next Steps

### Immediate Actions (Week 1)
1. **Approve Roadmap**: Review and sign off on all documents
2. **Assemble Team**: Assign engineers to workstreams
3. **Set Up Tracking**: Create GitHub Projects board
4. **Kickoff Meeting**: Review Phase 0 tasks
5. **Begin Development**: Start Docker Compose consolidation

### Week 2-4
- Complete Phase 0 (Foundation)
- Begin Phase 1 (Onboarding)
- Write documentation as you build
- Weekly demos and reviews

### Week 5+
- Continue through phases
- Bi-weekly user testing (if possible)
- Adjust roadmap based on learnings
- Maintain documentation

---

## Questions & Support

### For Questions About This Roadmap
- Create GitHub issue: [mycelia-tech/mycelia/issues](https://github.com/mycelia-tech/mycelia/issues)
- Tag: `roadmap`, `developer-experience`

### For Implementation Questions
- Refer to specific document (DX_ROADMAP, TASK_BREAKDOWN, etc.)
- Check `docs/` for technical details
- Ask in team channels

### For User Feedback
- Collect during user testing
- Monitor setup completion rates
- Track support tickets
- Conduct surveys after Phase 1

---

## Technical Documentation

### Core Architecture

#### [Architecture: Resources vs Workers/Jobs](../ARCHITECTURE.md)
**Purpose**: Explains the two core architectural patterns in Mycelia

**Contents**:
- Overview diagram showing the relationship between resources and workers
- Resource interface and available resources
- Worker/JobCapability interface and available workers
- Key differences between the two patterns
- Data flow example (audio processing pipeline)
- When to use each pattern

**Key Concepts**:
- **Resources**: Synchronous, authorized access to system capabilities (database, files, LLM)
- **Workers/Jobs**: Asynchronous background processing in isolated processes
- Workers consume resources via JWT-authenticated HTTP calls

---

### Audio Processing

#### [Speaker Identification](../SPEAKER_IDENTIFICATION.md)
**Purpose**: Guide for enrolling voices and recognizing speakers in recordings

**Contents**:
- Architecture overview (profiles → diarization → transcripts)
- Setup steps (GPU deployment, migrations, feature flags)
- Voice enrollment (recording, uploading samples)
- Retroactive matching (processing existing recordings)
- Configuration (similarity threshold, caching)
- Technical details (embedding model, matching algorithm, database schema)
- Troubleshooting common issues

**Key Features**:
- Enroll speaker voices with 10-30 second audio samples
- Automatic speaker labeling during diarization
- Named speakers in transcripts instead of "SPEAKER_00"
- Retroactive matching for historical recordings
