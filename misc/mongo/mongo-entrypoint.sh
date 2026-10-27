#!/bin/bash
set -e

# Get authentication credentials if provided
MONGO_ROOT_USERNAME="${MONGO_INITDB_ROOT_USERNAME:-}"
MONGO_ROOT_PASSWORD="${MONGO_INITDB_ROOT_PASSWORD:-}"

# Function to run mongosh with appropriate authentication
run_mongosh() {
  if [ -n "$MONGO_ROOT_USERNAME" ] && [ -n "$MONGO_ROOT_PASSWORD" ] && [ "$USE_AUTH" = "true" ]; then
    mongosh --quiet -u "$MONGO_ROOT_USERNAME" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin "$@"
  else
    mongosh --quiet "$@"
  fi
}

USE_AUTH="false"
MONGO_PID=""

# As container PID 1 this shell must forward Docker's stop signal. Waiting
# without a trap leaves mongod running until Docker forcibly kills it.
shutdown_mongo() {
  trap '' TERM INT
  if [ -n "$MONGO_PID" ]; then
    kill -TERM "$MONGO_PID" 2>/dev/null || true
    wait "$MONGO_PID" || true
  fi
  exit 0
}
trap shutdown_mongo TERM INT

# Start MongoDB in the background using the provided command or default
if [ $# -eq 0 ]; then
  echo "Starting MongoDB with default config..."
  mongod --config /etc/mongod.conf &
  MONGO_PID=$!
else
  echo "Starting MongoDB with provided command..."
  "$@" &
  MONGO_PID=$!
fi

# Wait for MongoDB to be ready
echo "Waiting for MongoDB to be ready..."
for i in {1..60}; do
  # Try without auth first (for first-time initialization)
  if mongosh --quiet --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
    echo "MongoDB is ready (no auth required)"
    USE_AUTH="false"
    break
  # If auth is enabled, try with credentials
  elif [ -n "$MONGO_ROOT_USERNAME" ] && [ -n "$MONGO_ROOT_PASSWORD" ]; then
    if mongosh --quiet -u "$MONGO_ROOT_USERNAME" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.adminCommand('ping')" > /dev/null 2>&1; then
      echo "MongoDB is ready (auth required)"
      USE_AUTH="true"
      break
    fi
  fi
  if [ $i -eq 60 ]; then
    echo "ERROR: MongoDB failed to become ready within 60 seconds"
    kill $MONGO_PID 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# Initialize replicaset if not already initialized
# Use 'mongo:27017' as the hostname so other containers can connect
echo "Checking replicaset status..."
run_mongosh --eval "
try {
  const status = rs.status();
  print('Replicaset already initialized: ' + status.set);
  const primary = status.members.find(m => m.stateStr === 'PRIMARY');
  if (primary) {
    print('PRIMARY: ' + primary.name);
    // Check if hostname needs to be updated
    const currentHost = primary.name;
    if (currentHost === 'localhost:27017' || currentHost.includes('localhost')) {
      print('Reconfiguring replicaset to use mongo:27017 instead of localhost...');
      const cfg = rs.conf();
      cfg.members[0].host = 'mongo:27017';
      rs.reconfig(cfg);
      print('Replicaset reconfigured to use mongo:27017');
    }
  } else {
    print('WARNING: No PRIMARY found, waiting for election...');
  }
} catch (error) {
  if (error.message.includes('no replset config has been received') ||
      error.message.includes('not yet initialized')) {
    print('Initializing replicaset with hostname mongo:27017...');
    rs.initiate({
      _id: 'rs0',
      members: [
        { _id: 0, host: 'mongo:27017' }
      ]
    });
    print('Replicaset initialization initiated');
  } else {
    print('Error checking replicaset status: ' + error);
    // Don't exit, let MongoDB continue running
  }
}
"

# Wait for PRIMARY to be elected (if we just initialized)
echo "Waiting for PRIMARY to be elected..."
for i in {1..60}; do
  if run_mongosh --eval "
    try {
      const status = rs.status();
      if (status.members && status.members.length > 0) {
        const primary = status.members.find(m => m.stateStr === 'PRIMARY');
        if (primary) {
          print('SUCCESS: PRIMARY elected at ' + primary.name);
          quit(0);
        }
      }
      quit(1);
    } catch (e) {
      quit(1);
    }
  " > /dev/null 2>&1; then
    echo "Replicaset is ready with PRIMARY"
    break
  fi
  if [ $i -eq 60 ]; then
    echo "WARNING: PRIMARY was not elected within 60 seconds, but continuing..."
  fi
  sleep 1
done

# Run user/database initialization scripts (only if database is empty)
# The original entrypoint already handles this, but we can run additional scripts here
# Note: init-mongo.sh will be run by the original entrypoint if DB is empty

# Wait for MongoDB process (keep container running)
echo "MongoDB initialization complete. Process PID: $MONGO_PID"
wait $MONGO_PID
