FROM python:3.12.13-slim-bookworm@sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get upgrade --yes \
    && apt-get install --yes --no-install-recommends ca-certificates openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --disable-pip-version-check --no-cache-dir pyspark==3.5.8 \
    && groupadd --gid 10001 analytics-purge \
    && useradd --create-home --uid 10001 --gid 10001 analytics-purge

COPY prepare_spark_image.py /tmp/prepare_spark_image.py
RUN python /tmp/prepare_spark_image.py \
    && rm /tmp/prepare_spark_image.py

WORKDIR /app
COPY --chown=10001:10001 purge_pending.py /app/purge_pending.py

USER 10001:10001

ENTRYPOINT ["timeout", "--signal=TERM", "--kill-after=30s", "40m", "python", "/app/purge_pending.py", "--execute"]
