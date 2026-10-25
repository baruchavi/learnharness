#!/bin/sh
set -eu
# A Kubernetes PVC hides the directories created in the image. Initialize
# the writable roots as the runtime user; never chown an existing dataset.
umask 077
mkdir -p -- "$LH_DATA_DIR" "$(dirname -- "$LH_AUTH_FILE")"
exec "$@"
