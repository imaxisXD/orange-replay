# Analytics container dependency audit — 2026-09-06

The official upgrades reduce risk, but **the container still includes libraries with known advisories**. The counts below identify installed versions. They do not establish that every issue can be exploited through Orange Replay.

Verified final image: `sha256:94cb523c6d13f45dccdba38a7559a56f2c4e2413e831aac576fd1f3802de48e2` (`linux/amd64`, runtime user `10001:10001`). The [portable security map](official-dependency-container-security-2026-09-06.json) retains every identified package, matched advisory, source link, exclusion and coverage limit. The [separate functional proof](official-dependency-iceberg-proof-2026-09-06.json) verifies old-to-new table compatibility and physical deletion.

## Coverage and results

The scan inventories **254 JARs / 454 identifiable Maven coordinates**, **3 installed Python distributions**, **18 pip-vendored packages**, and **130 Debian binaries / 94 source packages**. It queries OSV by package/version, checks the official Debian tracker by source version, and examines publisher code for the highest-priority application paths. This is broader than npm audit, which covers none of these packages.

| Category               | Final result                                     | What it means                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python distributions   | **0** OSV matches                                | Python packages are pip 26.2.1, PySpark 3.5.9 and Py4J 0.10.9.9. The official pip upgrade clears six earlier matches.                                                                                                                    |
| pip-vendored packages  | **3 raw matches excluded after code inspection** | The affected msgpack C/Cython implementation is absent; pip has only its Python fallback. The affected setuptools `PackageIndex` and `FileList` implementations are also absent. Exclusions and publisher links are retained in the map. |
| Maven packages         | **112 advisory IDs on 59 coordinates**           | **4 critical, 50 high, 51 moderate, 7 low**. Some come from relocated copies inside larger JARs. Presence and application exposure are assessed separately below.                                                                        |
| Debian source packages | **172 source-package/CVE matches**               | Tracker status: 171 open, 1 undetermined; 8 explicitly ignored, 39 postponed. No fixed Bookworm version is listed for these matches. Some concern unbuilt or unused features, such as the ignored minizip issue in zlib.                 |

Counts from different ecosystems are not a single count of exploitable application vulnerabilities. Some advisories describe unused servers, authentication modes or APIs, and shaded metadata can need further inspection.

## Highest-priority remaining findings

**Iceberg's REST client is on the configured application path.** Iceberg 1.10.2 bundles HttpClient 5.5 and HttpCore 5.3.4. Its REST catalog uses the classic HTTP client. The relevant response-handling defects can cause connection or memory exhaustion if a malicious catalog response reaches that code. The fixed dependency targets are 5.6.3 / 5.4.3; no hostile catalog response was exercised. Even official Iceberg 1.11.0 still selects HttpClient 5.6.1, below the required client fix. This cannot be honestly cleared by claiming that the latest parent release fixes everything. Sources: [client advisory](https://github.com/advisories/GHSA-hjcp-jmpx-g3qm), [core advisory](https://github.com/advisories/GHSA-hf6x-8p5f-cgmf), [Iceberg REST implementation](https://github.com/apache/iceberg/blob/apache-iceberg-1.10.2/core/src/main/java/org/apache/iceberg/rest/HTTPClient.java), [1.11 dependency declarations](https://github.com/apache/iceberg/blob/apache-iceberg-1.11.0/gradle/libs.versions.toml).

**Four critical matches remain in Spark/Hadoop's bundled libraries.** Their presence is verified; exposure through this local purge job is not demonstrated:

| Installed package           | Advisory                                                            | Application boundary                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Hadoop-relocated Avro 1.7.7 | [CVE-2024-47561](https://github.com/advisories/GHSA-r7pg-v2c8-mfg3) | Iceberg's configured reader carries a separate relocated Avro 1.12.1. The old copy's vulnerable schema path was not shown to be used. |
| ZooKeeper 3.6.3             | [CVE-2023-44981](https://github.com/advisories/GHSA-7286-pgfv-vxvh) | This local Spark job does not configure a ZooKeeper quorum.                                                                           |
| Jackson 1.9.13              | [CVE-2019-10202](https://github.com/advisories/GHSA-c27h-mcmw-48hv) | The job does not configure Jackson 1 polymorphic deserialization of incoming application data.                                        |
| Derby 10.14.2.0             | [CVE-2022-46337](https://github.com/advisories/GHSA-rcjc-c4pj-xxrp) | The job does not configure Derby LDAP authentication.                                                                                 |

**Spark's old Aircompressor copy remains.** Spark bundles 0.27; Iceberg separately bundles the fixed 2.0.3. The advisory requires crafted Snappy/LZ4 input and reused uncleared buffers. Use of Spark's older copy by the configured Iceberg deletion path was not established. The presence of a fixed relocated copy does not remove the old JAR from the inventory. [Publisher advisory](https://github.com/airlift/aircompressor/security/advisories/GHSA-vx9q-rhv9-3jvg).

Other notable bundled versions are Spark Avro 1.11.5 / Parquet 1.13.1, Iceberg Avro 1.12.1 / Parquet 1.16.0, and Iceberg's AWS SDK 2.33.0 / Netty 4.1.124. The default Iceberg synchronous AWS client uses Apache HTTP, so the AWS bundle's Netty async client is an optional path; separate Spark Netty use remains possible. Every matched coordinate and advisory is in the portable map.

## Official upgrade limits and next work

1. Keep the matched, verified official container releases in this candidate. Do not remove scanner entries, replace individual JARs, or add unpublished package fixes to manufacture a clean report.
2. A later official Iceberg parent release must include the fixed REST HTTP client and retain working R2-vended credential behavior. Iceberg 1.11.0 has a [reported credential-refresh regression](https://github.com/apache/iceberg/issues/17810) as well as the dependency limit above.
3. Spark 4 is a separate migration: Scala 2.13, a corresponding Iceberg runtime, Python 3.10+, supported Java, and explicit SQL/deletion/snapshot checks. Spark 4.1.3 still includes affected Netty 4.2.7 and Thrift 0.16; a major upgrade is not a complete cure. See the [Spark migration guide](https://spark.apache.org/docs/4.1.3/sql-migration-guide.html), [official Spark dependencies](https://github.com/apache/spark/blob/v4.1.3/pom.xml), and [Iceberg compatibility table](https://iceberg.apache.org/multi-engine-support/).
4. Before production promotion, verify the candidate against a disposable Cloudflare REST/R2 catalog fixture and assess the remaining active-client findings. The completed Hadoop fixture uses no production credentials or network and cannot answer those external integration questions.

This pass did not fuzz parsers, demonstrate exploits, enumerate every hidden native dependency, or test production network exposure. It establishes the selected versions, known advisory matches, important conditions for exploitation and the limits of an official-parent-only upgrade.
