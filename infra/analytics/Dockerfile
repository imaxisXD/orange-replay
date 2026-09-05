FROM python:3.12.14-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get upgrade --yes \
    && apt-get install --yes --no-install-recommends ca-certificates openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --disable-pip-version-check --no-cache-dir --upgrade pip==26.2.1 \
    && python -m pip install --disable-pip-version-check --no-cache-dir pyspark==3.5.9 \
    && groupadd --gid 10001 analytics-purge \
    && useradd --create-home --uid 10001 --gid 10001 analytics-purge

COPY prepare_spark_image.py /tmp/prepare_spark_image.py
RUN python /tmp/prepare_spark_image.py \
    && rm /tmp/prepare_spark_image.py

WORKDIR /app
COPY --chown=10001:10001 purge_pending.py /app/purge_pending.py

USER 10001:10001

ENTRYPOINT ["timeout", "--signal=TERM", "--kill-after=30s", "40m", "python", "/app/purge_pending.py", "--execute"]
