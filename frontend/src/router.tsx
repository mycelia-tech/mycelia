import { createBrowserRouter } from "react-router-dom";
import Layout from "./components/Layout";
import HomePage from "./pages/HomePage";
import TimelinePage from "./pages/TimelinePage";
import MapPage from "./pages/MapExperiencePage";
import ChatPage from "./pages/ChatPage";
import SettingsLayout from "./components/SettingsLayout";
import GeneralSettingsPage from "./pages/settings/GeneralSettingsPage";
import APISettingsPage from "./pages/settings/APISettingsPage";
import InferenceSettingsPage from "./pages/settings/InferenceSettingsPage";
import TranscriptionSettingsPage from "./pages/settings/TranscriptionSettingsPage";
import DiarizationSettingsPage from "./pages/settings/DiarizationSettingsPage";
import PromptsPage from "./pages/settings/PromptsPage";
import FeatureFlagsPage from "./pages/settings/FeatureFlagsPage";
import AccessLogPage from "./pages/settings/AccessLogPage";
import WorkersPage from "./pages/settings/WorkersPage";
import MapsSettingsPage from "./pages/settings/MapsSettingsPage";
import WorkerDetailPage from "./pages/settings/WorkerDetailPage";
import VoiceProfilesPage from "./pages/settings/VoiceProfilesPage";
import VoiceIdentityReviewPage from "./pages/settings/VoiceIdentityReviewPage";
import VoiceIdentityOperationsPage from "./pages/settings/VoiceIdentityOperationsPage";
import ConfigSettingsPage from "./pages/settings/ConfigSettingsPage";
import NotFoundPage from "./pages/NotFoundPage";
import TranscriptPage from "./pages/TranscriptPage";
import DiarizationDetailPage from "./pages/DiarizationDetailPage";
import ObjectsPage from "./pages/ObjectsPage";
import ObjectDetailPage from "./pages/ObjectDetailPage";
import ObjectHistoryPage from "./pages/ObjectHistoryPage";
import CreateObjectPage from "./pages/CreateObjectPage";
import CreateAudioRecordPage from "./pages/CreateAudioRecordPage";
import AudioPlayerPage from "./pages/AudioPlayerPage";
import AudioSourceFilesPage from "./pages/AudioSourceFilesPage";
import AudioSourceFileDetailPage from "./pages/AudioSourceFileDetailPage";
import AudioExportPage from "./pages/AudioExportPage";
import MessengerPage from "./pages/MessengerPage";
import OAuthConsentPage from "./pages/OAuthConsentPage";
import SetupPage from "./pages/SetupPage";
import InferenceSetupPage from "./pages/setup/InferenceSetupPage";
import JobsPage from "./pages/JobsPage";
import JobDetailPage from "./pages/JobDetailPage";
import CreateJobPage from "./pages/CreateJobPage";
import ConversationsPage from "./pages/ConversationsPage";
import AudioPipelinePage from "./pages/AudioPipelinePage";
import SummaryHistoryPage from "./pages/SummaryHistoryPage";
import MediaPage from "./pages/MediaPage";
import MediaAnalysisPage from "./pages/MediaAnalysisPage";
import GoogleCloudSettingsPage from "./pages/settings/GoogleCloudSettingsPage";
import PhotoAnalysisSettingsPage from "./pages/settings/PhotoAnalysisSettingsPage";
import SearchPage from "./pages/SearchPage";
import KnowledgeSettingsPage from "./pages/settings/KnowledgeSettingsPage";

export const router = createBrowserRouter([
  {
    path: "/oauth/consent",
    element: <OAuthConsentPage />,
  },
  {
    path: "/setup",
    element: <SetupPage />,
  },
  {
    path: "/setup/inference",
    element: <InferenceSetupPage />,
  },
  {
    path: "/",
    element: <Layout />,
    children: [
      {
        index: true,
        element: <HomePage />,
      },
      {
        path: "timeline",
        element: <TimelinePage />,
      },
      {
        path: "map",
        element: <MapPage />,
      },
      {
        path: "jobs",
        element: <JobsPage />,
      },
      {
        path: "jobs/new",
        element: <CreateJobPage />,
      },
      {
        path: "jobs/:id",
        element: <JobDetailPage />,
      },
      {
        path: "summaries",
        element: <SummaryHistoryPage />,
      },
      {
        path: "messaging",
        element: <MessengerPage />,
      },
      {
        path: "messaging/:chatId",
        element: <MessengerPage />,
      },
      {
        path: "chat",
        element: <ChatPage />,
      },
      {
        path: "chat/:chatId",
        element: <ChatPage />,
      },
      {
        path: "search",
        element: <SearchPage />,
      },
      {
        path: "transcript",
        element: <TranscriptPage />,
      },
      {
        path: "conversations",
        element: <ConversationsPage />,
      },
      {
        path: "diarizations/:id",
        element: <DiarizationDetailPage />,
      },
      {
        path: "audio",
        element: <AudioPlayerPage />,
      },
      {
        path: "audio/pipeline",
        element: <AudioPipelinePage />,
      },
      {
        path: "audio/source_files",
        element: <AudioSourceFilesPage />,
      },
      {
        path: "audio/source_files/:id",
        element: <AudioSourceFileDetailPage />,
      },
      {
        path: "audio/record",
        element: <CreateAudioRecordPage />,
      },
      {
        path: "audio/export",
        element: <AudioExportPage />,
      },
      {
        path: "objects",
        element: <ObjectsPage />,
      },
      {
        path: "media",
        element: <MediaPage />,
      },
      {
        path: "media/analysis",
        element: <MediaAnalysisPage />,
      },
      {
        path: "objects/create",
        element: <CreateObjectPage />,
      },
      {
        path: "objects/:id",
        element: <ObjectDetailPage />,
      },
      {
        path: "objects/:id/history",
        element: <ObjectHistoryPage />,
      },
      {
        path: "settings",
        element: <SettingsLayout />,
        children: [
          {
            index: true,
            element: <GeneralSettingsPage />,
          },
          {
            path: "api",
            element: <APISettingsPage />,
          },
          {
            path: "inference",
            element: <InferenceSettingsPage />,
          },
          {
            path: "speech-to-text",
            element: <TranscriptionSettingsPage />,
          },
          {
            path: "diarization",
            element: <DiarizationSettingsPage />,
          },
          {
            path: "prompts",
            element: <PromptsPage />,
          },
          {
            path: "config",
            element: <ConfigSettingsPage />,
          },
          {
            path: "access-log",
            element: <AccessLogPage />,
          },
          {
            path: "feature-flags",
            element: <FeatureFlagsPage />,
          },
          {
            path: "workers",
            element: <WorkersPage />,
          },
          {
            path: "workers/:workerType",
            element: <WorkerDetailPage />,
          },
          {
            path: "maps",
            element: <MapsSettingsPage />,
          },
          {
            path: "google-cloud",
            element: <GoogleCloudSettingsPage />,
          },
          { path: "photo-analysis", element: <PhotoAnalysisSettingsPage /> },
          {
            path: "knowledge",
            element: <KnowledgeSettingsPage />,
          },
          {
            path: "voice-profiles",
            element: <VoiceProfilesPage />,
          },
          {
            path: "voice-identity",
            element: <VoiceIdentityReviewPage />,
          },
          {
            path: "voice-identity/operations",
            element: <VoiceIdentityOperationsPage />,
          },
        ],
      },
      {
        path: "*",
        element: <NotFoundPage />,
      },
    ],
  },
]);
