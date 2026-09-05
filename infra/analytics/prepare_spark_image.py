"""Download and verify the pinned Iceberg JARs during the image build."""

from __future__ import annotations

import hashlib
from pathlib import Path
import urllib.request


JARS = (
    (
        "https://repo1.maven.org/maven2/org/apache/iceberg/"
        "iceberg-spark-runtime-3.5_2.12/1.10.2/"
        "iceberg-spark-runtime-3.5_2.12-1.10.2.jar",
        "c562d482dcd16b666e808b755469fbc4b2604284b41622c9d87e2c02b7cc6c5f",
    ),
    (
        "https://repo1.maven.org/maven2/org/apache/iceberg/"
        "iceberg-aws-bundle/1.10.2/iceberg-aws-bundle-1.10.2.jar",
        "a2395ab49bf87e971e5588db644194ac18e9c0e0b44a7ad5a422a97648a38415",
    ),
)
JAR_DIRECTORY = Path("/usr/local/lib/python3.12/site-packages/pyspark/jars")


def download_verified_jar(url: str, expected_sha256: str) -> None:
    target = JAR_DIRECTORY / url.rsplit("/", 1)[-1]
    temporary_target = target.with_suffix(target.suffix + ".part")
    digest = hashlib.sha256()
    try:
        with (
            urllib.request.urlopen(url, timeout=60) as response,
            temporary_target.open("wb") as destination,
        ):
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                destination.write(chunk)
        if digest.hexdigest() != expected_sha256:
            raise RuntimeError(f"checksum did not match for {target.name}")
        temporary_target.replace(target)
    finally:
        temporary_target.unlink(missing_ok=True)


for jar_url, jar_sha256 in JARS:
    download_verified_jar(jar_url, jar_sha256)
