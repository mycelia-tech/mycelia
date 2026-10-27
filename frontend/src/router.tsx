import { lazy, type ReactNode, Suspense } from "react";
import { PageLoading, RouteError } from "./components/RouteError";
import { createBrowserRouter } from "react-router-dom";
import Layout from "./components/Layout";
const HomePage = lazy(() => import("./pages/HomePage"));
const TimelinePage = lazy(() => import("./pages/TimelinePage"));
const MapPage = lazy(() => import("./pages/MapExperiencePage"));
const ChatPage = lazy(() => import("./pages/ChatPage"));
import SettingsLayout from "./components/SettingsLayout";
const GeneralSettingsPage = lazy(() =>
  import("./pages/settings/GeneralSettingsPage")
);
const APISettingsPage = lazy(() => import("./pages/settings/APISettingsPage"));
const InferenceSettingsPage = lazy(() =>
  import("./pages/settings/InferenceSettingsPage")
);
const TranscriptionSettingsPage = lazy(() =>
  import("./pages/settings/TranscriptionSettingsPage")
);
const DiarizationSettingsPage = lazy(() =>
  import("./pages/settings/DiarizationSettingsPage")
);
const PromptsPage = lazy(() => import("./pages/settings/PromptsPage"));
const FeatureFlagsPage = lazy(() =>
  import("./pages/settings/FeatureFlagsPage")
);
const AccessLogPage = lazy(() => import("./pages/settings/AccessLogPage"));
const WorkersPage = lazy(() => import("./pages/settings/WorkersPage"));
const MapsSettingsPage = lazy(() =>
  import("./pages/settings/MapsSettingsPage")
);
const WorkerDetailPage = lazy(() =>
  import("./pages/settings/WorkerDetailPage")
);
const VoiceProfilesPage = lazy(() =>
  import("./pages/settings/VoiceProfilesPage")
);
const VoiceIdentityReviewPage = lazy(() =>
  import("./pages/settings/VoiceIdentityReviewPage")
);
const VoiceIdentityOperationsPage = lazy(() =>
  import("./pages/settings/VoiceIdentityOperationsPage")
);
const ConfigSettingsPage = lazy(() =>
  import("./pages/settings/ConfigSettingsPage")
);
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));
const TranscriptPage = lazy(() => import("./pages/TranscriptPage"));
const DiarizationDetailPage = lazy(() =>
  import("./pages/DiarizationDetailPage")
);
const ObjectsPage = lazy(() => import("./pages/ObjectsPage"));
const ObjectDetailPage = lazy(() => import("./pages/ObjectDetailPage"));
const ObjectHistoryPage = lazy(() => import("./pages/ObjectHistoryPage"));
const CreateObjectPage = lazy(() => import("./pages/CreateObjectPage"));
const CreateAudioRecordPage = lazy(() =>
  import("./pages/CreateAudioRecordPage")
);
const AudioPlayerPage = lazy(() => import("./pages/AudioPlayerPage"));
const AudioSourceFilesPage = lazy(() => import("./pages/AudioSourceFilesPage"));
const AudioSourceFileDetailPage = lazy(() =>
  import("./pages/AudioSourceFileDetailPage")
);
const AudioExportPage = lazy(() => import("./pages/AudioExportPage"));
const MessengerPage = lazy(() => import("./pages/MessengerPage"));
const OAuthConsentPage = lazy(() => import("./pages/OAuthConsentPage"));
const SetupPage = lazy(() => import("./pages/SetupPage"));
const InferenceSetupPage = lazy(() =>
  import("./pages/setup/InferenceSetupPage")
);
const JobsPage = lazy(() => import("./pages/JobsPage"));
const JobDetailPage = lazy(() => import("./pages/JobDetailPage"));
const CreateJobPage = lazy(() => import("./pages/CreateJobPage"));
const ConversationsPage = lazy(() => import("./pages/ConversationsPage"));
const AudioPipelinePage = lazy(() => import("./pages/AudioPipelinePage"));
const SummaryHistoryPage = lazy(() => import("./pages/SummaryHistoryPage"));
const MediaPage = lazy(() => import("./pages/MediaPage"));
const MediaAnalysisPage = lazy(() => import("./pages/MediaAnalysisPage"));
const GoogleCloudSettingsPage = lazy(() =>
  import("./pages/settings/GoogleCloudSettingsPage")
);
const PhotoAnalysisSettingsPage = lazy(() =>
  import("./pages/settings/PhotoAnalysisSettingsPage")
);
const SearchPage = lazy(() => import("./pages/SearchPage"));
const KnowledgeSettingsPage = lazy(() =>
  import("./pages/settings/KnowledgeSettingsPage")
);

function page(element: ReactNode) {
  return <Suspense fallback={<PageLoading />}>{element}</Suspense>;
}

export const router = createBrowserRouter([
  {
    path: "/oauth/consent",
    element: page(<OAuthConsentPage />),
    errorElement: <RouteError />,
  },
  {
    path: "/setup",
    element: page(<SetupPage />),
    errorElement: <RouteError />,
  },
  {
    path: "/setup/inference",
    element: page(<InferenceSetupPage />),
    errorElement: <RouteError />,
  },
  {
    path: "/",
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      {
        index: true,
        element: page(<HomePage />),
        errorElement: <RouteError />,
      },
      {
        path: "timeline",
        element: page(<TimelinePage />),
        errorElement: <RouteError />,
      },
      {
        path: "map",
        element: page(<MapPage />),
        errorElement: <RouteError />,
      },
      {
        path: "jobs",
        element: page(<JobsPage />),
        errorElement: <RouteError />,
      },
      {
        path: "jobs/new",
        element: page(<CreateJobPage />),
        errorElement: <RouteError />,
      },
      {
        path: "jobs/:id",
        element: page(<JobDetailPage />),
        errorElement: <RouteError />,
      },
      {
        path: "summaries",
        element: page(<SummaryHistoryPage />),
        errorElement: <RouteError />,
      },
      {
        path: "messaging",
        element: page(<MessengerPage />),
        errorElement: <RouteError />,
      },
      {
        path: "messaging/:chatId",
        element: page(<MessengerPage />),
        errorElement: <RouteError />,
      },
      {
        path: "chat",
        element: page(<ChatPage />),
        errorElement: <RouteError />,
      },
      {
        path: "chat/:chatId",
        element: page(<ChatPage />),
        errorElement: <RouteError />,
      },
      {
        path: "search",
        element: page(<SearchPage />),
        errorElement: <RouteError />,
      },
      {
        path: "transcript",
        element: page(<TranscriptPage />),
        errorElement: <RouteError />,
      },
      {
        path: "conversations",
        element: page(<ConversationsPage />),
        errorElement: <RouteError />,
      },
      {
        path: "diarizations/:id",
        element: page(<DiarizationDetailPage />),
        errorElement: <RouteError />,
      },
      {
        path: "audio",
        element: page(<AudioPlayerPage />),
        errorElement: <RouteError />,
      },
      {
        path: "audio/pipeline",
        element: page(<AudioPipelinePage />),
        errorElement: <RouteError />,
      },
      {
        path: "audio/source_files",
        element: page(<AudioSourceFilesPage />),
        errorElement: <RouteError />,
      },
      {
        path: "audio/source_files/:id",
        element: page(<AudioSourceFileDetailPage />),
        errorElement: <RouteError />,
      },
      {
        path: "audio/record",
        element: page(<CreateAudioRecordPage />),
        errorElement: <RouteError />,
      },
      {
        path: "audio/export",
        element: page(<AudioExportPage />),
        errorElement: <RouteError />,
      },
      {
        path: "objects",
        element: page(<ObjectsPage />),
        errorElement: <RouteError />,
      },
      {
        path: "media",
        element: page(<MediaPage />),
        errorElement: <RouteError />,
      },
      {
        path: "media/analysis",
        element: page(<MediaAnalysisPage />),
        errorElement: <RouteError />,
      },
      {
        path: "objects/create",
        element: page(<CreateObjectPage />),
        errorElement: <RouteError />,
      },
      {
        path: "objects/:id",
        element: page(<ObjectDetailPage />),
        errorElement: <RouteError />,
      },
      {
        path: "objects/:id/history",
        element: page(<ObjectHistoryPage />),
        errorElement: <RouteError />,
      },
      {
        path: "settings",
        element: <SettingsLayout />,
        children: [
          {
            index: true,
            element: page(<GeneralSettingsPage />),
            errorElement: <RouteError />,
          },
          {
            path: "api",
            element: page(<APISettingsPage />),
            errorElement: <RouteError />,
          },
          {
            path: "inference",
            element: page(<InferenceSettingsPage />),
            errorElement: <RouteError />,
          },
          {
            path: "speech-to-text",
            element: page(<TranscriptionSettingsPage />),
            errorElement: <RouteError />,
          },
          {
            path: "diarization",
            element: page(<DiarizationSettingsPage />),
            errorElement: <RouteError />,
          },
          {
            path: "prompts",
            element: page(<PromptsPage />),
            errorElement: <RouteError />,
          },
          {
            path: "config",
            element: page(<ConfigSettingsPage />),
            errorElement: <RouteError />,
          },
          {
            path: "access-log",
            element: page(<AccessLogPage />),
            errorElement: <RouteError />,
          },
          {
            path: "feature-flags",
            element: page(<FeatureFlagsPage />),
            errorElement: <RouteError />,
          },
          {
            path: "workers",
            element: page(<WorkersPage />),
            errorElement: <RouteError />,
          },
          {
            path: "workers/:workerType",
            element: page(<WorkerDetailPage />),
            errorElement: <RouteError />,
          },
          {
            path: "maps",
            element: page(<MapsSettingsPage />),
            errorElement: <RouteError />,
          },
          {
            path: "google-cloud",
            element: page(<GoogleCloudSettingsPage />),
            errorElement: <RouteError />,
          },
          { path: "photo-analysis", element: <PhotoAnalysisSettingsPage /> },
          {
            path: "knowledge",
            element: page(<KnowledgeSettingsPage />),
            errorElement: <RouteError />,
          },
          {
            path: "voice-profiles",
            element: page(<VoiceProfilesPage />),
            errorElement: <RouteError />,
          },
          {
            path: "voice-identity",
            element: page(<VoiceIdentityReviewPage />),
            errorElement: <RouteError />,
          },
          {
            path: "voice-identity/operations",
            element: page(<VoiceIdentityOperationsPage />),
            errorElement: <RouteError />,
          },
        ],
      },
      {
        path: "*",
        element: page(<NotFoundPage />),
        errorElement: <RouteError />,
      },
    ],
  },
]);
