// The password stays in the container environment, never command arguments/logs.
try {
  const admin = db.getSiblingDB("admin");
  if (!process.env.MONGO_HEALTH_USERNAME || !process.env.MONGO_HEALTH_PASSWORD) quit(1);
  if (!admin.auth(process.env.MONGO_HEALTH_USERNAME, process.env.MONGO_HEALTH_PASSWORD)) quit(1);
  const status = admin.runCommand({ replSetGetStatus: 1 });
  quit(status.ok === 1 && status.myState === 1 ? 0 : 1);
} catch (_) { quit(1); }
