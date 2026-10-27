import { z } from "zod";
import { NetworkJobCapability } from "./python.ts";

export const schema = z.object({
  type: z.literal("profileReenrollment"),
  profileId: z.string().min(1),
  diarizationServerUrl: z.string().url().optional(),
});

const PYTHON_WORKER_URL = Deno.env.get("PYTHON_WORKER_URL") ||
  "http://localhost:8000";

export default new NetworkJobCapability({
  name: "profileReenrollment",
  schema,
  url: `${PYTHON_WORKER_URL}/jobs/profileReenrollment`,
  policies: [
    { resource: "db/speaker_profiles", action: "*", effect: "allow" },
    { resource: "fs/voice_samples", action: "download", effect: "allow" },
    { resource: "db/voice_samples.files", action: "read", effect: "allow" },
    { resource: "db/voice_samples.chunks", action: "read", effect: "allow" },
    {
      resource: "speaker-segments",
      action: "invalidate-profile-identity-evidence",
      effect: "allow",
    },
  ],
});
