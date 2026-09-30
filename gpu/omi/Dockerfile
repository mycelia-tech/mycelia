ARG OMI_BASE_IMAGE=omiloc-docker-app:latest
FROM ${OMI_BASE_IMAGE}

USER root
COPY patch_audio_compat.py /tmp/patch_audio_compat.py
RUN python /tmp/patch_audio_compat.py \
      /opt/omiloc/scripts/dev-harness/dev_harness/local_stt.py \
      /opt/omiloc/backend/utils/offline_audio_capture.py \
      /opt/omiloc/docker/runtime.py \
      /opt/omiloc/scripts/dev-harness/dev_harness/local_stt_services.py \
    && rm /tmp/patch_audio_compat.py
USER omi
