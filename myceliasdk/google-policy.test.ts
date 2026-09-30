import { assertEquals, assertThrows } from "@std/assert";
import {
  assertGoogleAccess,
  isGoogleDestination,
  validatePhotoEndpoint,
} from "./google-policy.ts";

Deno.test("Google policy blocks direct and brokered Gemini even with an old profile", () => {
  for (
    const destination of [
      { providerType: "google-cloud" },
      { baseUrl: "https://eu-vision.googleapis.com/v1" },
      {
        baseUrl: "https://openrouter.ai/api/v1",
        model: "google/gemini-2.5-flash",
      },
      { model: "models/gemini-vision" },
    ]
  ) {
    assertThrows(
      () => assertGoogleAccess({}, destination),
      Error,
      "GOOGLE_SERVICES_DISABLED",
    );
    assertGoogleAccess(
      { externalServices: { google: { enabled: true } } },
      destination,
    );
  }
  assertGoogleAccess({}, {
    baseUrl: "http://localhost:8080/v1",
    model: "vision",
  });
  assertEquals(
    isGoogleDestination({ baseUrl: "https://googleapis.com.evil.test" }),
    false,
  );
});

Deno.test("photo endpoints accept deliberate local servers but reject metadata and embedded secrets", () => {
  assertEquals(
    validatePhotoEndpoint("http://localhost:8080/v1/"),
    "http://localhost:8080/v1",
  );
  for (
    const url of [
      "file:///secret",
      "http://169.254.169.254/",
      "http://metadata.google.internal/",
      "https://user:secret@host/v1",
      "https://host/v1?key=secret",
      "http://[::ffff:a9fe:a9fe]/",
    ]
  ) {
    assertThrows(() => validatePhotoEndpoint(url));
  }
});
