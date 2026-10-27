# Mycelia documentation

The repository implements a personal, self-hosted memory system. Start with the
current guides below; dated proposals are not deployment or completion reports.

For the current improvement package, see [implementation and validation](REPOSITORY_IMPROVEMENTS.md).

| Task | Guide |
| --- | --- |
| Install and understand features | [Project README](../README.md) |
| Develop, test, and verify runtime source/readiness | [Development](../DEVELOPMENT.md) |
| Understand service and storage boundaries | [Architecture](ARCHITECTURE.md), [Database](DATABASE.md) |
| Audio processing and recovery | [Jobs](JOB_QUEUE.md), [Voice identity](VOICE_IDENTITY_RUNBOOK.md) |
| Find memories | [Search manual](RAG_UI_MANUAL.md), [RAG architecture](RAG_QDRANT.md) |
| Photos, PDFs and locations | [Media](MEDIA_KNOWLEDGE.md), [Locations](LOCATIONS.md) |
| Authentication and hardening | [Authentication](AUTH.md), [Hardening rollout](HARDENING.md) |
| Database access migration | [Mongo authorization](MONGO_AUTH.md), [Networking](NETWORKING.md) |
| Preserve and recover data | [Backups](BACKUP.md) |

Historical design material: [2025 DX proposal](archive/dx-roadmap-index-2025.md),
[DX roadmap](DX_ROADMAP.md), [task breakdown](TASK_BREAKDOWN.md). The disabled
[Gitea workflow](archive/gitea-build.yaml) references removed implementation and
must not be used for deployment.
