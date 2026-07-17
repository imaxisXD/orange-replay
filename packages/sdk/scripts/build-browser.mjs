import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, minify } from "vite";
import { minify as minifyWithTerser } from "terser";
import ts from "typescript";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = resolve(packageDir, "dist");
const workerEntryPath = resolve(packageDir, "src/pipeline/worker-entry.ts");
const rrwebTypesPath = resolve(packageDir, "../rrweb-fork/src/vendor/rrweb-types/index.ts");
// These names are private to the built recorder. Keep public API, DOM, and
// replay wire names (for example, nextId) out of this list.
const privateBrowserProperty = new RegExp(
  `^(?:${`
    workerHost onCheckpointRequested onWorkerUnavailable indexEvents backpressure
    rrwebEvents pendingWorkerEvents eventMetas inFlightBatches currentUrl timerId
    addPageLoadEvent addQueuedEvent recordNavigation patchHistory viewport asElement scrollDepth
    addDomListener
    warnedAboutInternalError needsFollowUpFlush workerPostScheduled pagehideResetPending
    oversizedSnapshotBytes needsRequiredCheckpoint requiredCheckpointRequested requiredBaselineMissing
    pendingRequiredFinalBatches pageHidden newSessionPending sessionChangeRunning
    prepareForSnapshotPart deferIframeDocuments textIndexById attributeIndexById
    containsRequiredSnapshot
    queuedEventCount droppedEventCount requiredSnapshot fullSnapshot pagehideRequiredOversized
    pagehideEstimateUnknown rawBytes
    capBytes currentBytes pendingBytes canAccept addCurrentBytes removeCurrentBytes addPendingBytes
    removePendingBytes bufferedBytes recordDropped resetCurrentBytes addEstimatedBytes takeBatch
    retuneFromAck currentRawBytes getFlushMs getPagehideRawFlushBytes
    timeSliceMs shouldStop beforeSnapshot afterTopology onShadowRoot onIframeDocument
    getTopologyRevision getPrivacyRevision onSnapshotUnstable privacyParent skipPreparation
    flushInternal flushNow flushOne flushFinalBatchesSync takeCurrentFinalBatch
    dropCurrentFinalBatch queueSyncFinalBatch flushWorkerBatch recordDroppedFromWorker resetPipeline
    clearPipelineBuffers stopAfterServerDrop disableAfterInternalError discardPipeline
    continueRequiredCheckpointRecovery markRequiredBaselineMissing discardEventsAfterMissingBaseline
    queueWorkerEvent flushPendingWorkerEvents
    scheduleTimer clearTimer onVisibilityChange onPageHide onPageShow revokeObjectUrl flushTimeoutMs
    yieldToMain onUnavailable objectUrl transferVersion transferQueue unavailableReported
    useDegradedMode sendEvents sendSnapshotTree handleWorkerMessage rejectPending handleWorkerFailure
    disableWorker reportUnavailable lastSourceByImage imageQueue queuedImages waitingImages
    snapshotGeneration scheduleNextCapture captureNextLoadedImage captureImage pendingCanvasIds
    lastFrameHashByCanvas trackedCanvases trackedCanvasQueue trackedCanvasCursor animationFrameId
    lastCaptureTime captureIntervalMs captureNextCanvas observedDocuments capturedDocuments
    currentDocuments documentOwners iframeLoadCleanups observerCleanups snapshotListener
    documentRemovedListener trackDocument clearDocument shadowDoms trackedShadowRoots restoreHandlers
    iframeOwners observedIframeDocuments iframeDocuments patchAttachShadow topologyGeneration
    reserveNextId idNodeMap nodeMetaMap startTopologyCapture
    hasActiveReservationForCurrentGeneration addIframe addLoadListener addSnapshotListener
    addDocumentRemovedListener snapshotLoadedIframe observeIframe isCurrentDocument isCurrentIframe
    removeContainedIframes attachIframe prepareForFullSnapshot finishFullSnapshot trackImage
    removeContainedImages addShadowRoot emitAdoptedStyleSheetsForSnapshot removeContainedRoots
    observeAttachShadow removeDocument attachLinkElement adoptStyleSheets inOtherBuffer
    makeId broadcastChannel channel storage currentSessionId currentTabId lastActivity
    lastActivityPersistedAt
    reclaimForCurrentSession openClaimChannel postTabClaim makeTabId readCookieSession
    writeCookieSession persistSeq claimTabOwnership persist resumeAfterIdle rotate
    resumeSessionAfterIdle requestSessionChange drainSessionChanges prepareForSessionChange
    takeFullSnapshot
    projectRef ready nextSeq touch
    afterCapturedTopology capturedChunks capturedNodes capturedParentIndexes capturedFlags
    capturedLiveIds capturedNextIndexes capturedLastChildIndexes addCapturedNode getChunk getNode
    getParentIndex getFlags setFlags getLiveId getNextLiveId releaseReconciliationValues
    stopRecord discardPendingRecords revokeWorkerUrl sink bypassOptions pagehideRawFlushBytes
    totalRawBytes isAvailable wrappedEmit eventRawBytes rawFlushBytes queueBatchSync timeoutId
    addRrwebEvent queueCustomEvent flushing startIdReservation stopIdReservation
    drainPendingCustomEvents trackCanvas kill adoptedStyleSheetCb fetchFn warned addIndexEvent
    adopters adoptersBySheet prepareAdoptedSheetMutation removeAdopter trackAdopters
    emitAdoptedStyleSheets
    originalReplaceState originalPushState recorder scrollCb styleMirror requestSnapshot
    removesSubTreeCache batcher pendingCustomEvents onNavigation drainPreBuffer onUnhandledRejection
    genTextAreaValueMutation removeNodeFromMap encoder unattachedDoc styleIDMap lastScrollAt updateMeta
    genAdds activateReservation flushBatch sendBatch getId addedSet addEvents onScroll onError frozen
    isActiveNode movedSet lastSnapshotAt mapRemoves sidecar hasNode scheduled processMutations nodeMap
    removers movedMap isRemovedNode setObserver droppedSet getMeta queueImage loadListener tail addNode
    onClick attributeMap forgetNode processMutation resetObservers drain previous maxBodyBytes
    reuseIdsFrom stopTouchListeners styleDiff _unchangedStyles onIframeLoad finalQueued
  `
    .trim()
    .split(/\s+/)
    .join("|")})$`,
);
const rrwebNumericEnums = parseNumericEnums(await readFile(rrwebTypesPath, "utf8"));
const { makeWorkerEntrySource } = await import(workerEntryPath);
const compactWorker = await minify("orange-replay-worker.js", makeWorkerEntrySource(), {
  module: false,
  compress: true,
  mangle: true,
  codegen: { removeWhitespace: true, legalComments: "none" },
});
if (compactWorker.errors.length > 0) throw new Error("Could not compact the recorder worker.");
const optimizedWorker = await minifyWithTerser(compactWorker.code, {
  ecma: 2022,
  module: true,
  compress: { passes: 3, toplevel: true },
  mangle: { toplevel: true },
  format: { comments: false },
});
if (optimizedWorker.code === undefined) throw new Error("Could not optimize the recorder worker.");
const compactWorkerSource = optimizedWorker.code;

await rm(distDir, { recursive: true, force: true });

const commonBuild = {
  target: "es2022",
  minify: true,
  sourcemap: false,
  emptyOutDir: false,
  outDir: distDir,
};

await buildRecorderBundle("es", "orange-replay.js", false);
await buildRecorderBundle("iife", "orange-replay.iife.js", true);

await build({
  root: packageDir,
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  build: {
    ...commonBuild,
    lib: {
      entry: resolve(packageDir, "src/loader-runtime.ts"),
      name: "OrangeReplayLoader",
      formats: ["iife"],
      fileName() {
        return "loader-runtime.js";
      },
    },
  },
});

async function buildRecorderBundle(format, fileName, autoInit) {
  await build({
    root: packageDir,
    configFile: false,
    publicDir: false,
    logLevel: "warn",
    define: {
      __ORANGE_REPLAY_AUTO_INIT__: JSON.stringify(autoInit),
      __ORANGE_REPLAY_SDK_PROFILE__: "true",
      // Orange Replay does not expose cross-origin iframe recording. Keep the
      // generic rrweb-fork path available to its own users without shipping it
      // in the customer SDK.
      __ORANGE_REPLAY_INCLUDE_CROSS_ORIGIN_IFRAMES__: "false",
    },
    plugins: [
      inlineRrwebNumericEnums(),
      {
        name: "orange-replay-worker-source",
        transform(_source, id) {
          if (id !== workerEntryPath) return;
          return `export function makeWorkerEntrySource(){return ${JSON.stringify(
            compactWorkerSource,
          )}}`;
        },
      },
    ],
    build: {
      ...commonBuild,
      lib: {
        entry: resolve(packageDir, format === "iife" ? "src/browser.ts" : "src/index.ts"),
        name: "OrangeReplay",
        formats: [format],
        fileName() {
          return fileName;
        },
      },
      rollupOptions: {
        output: {
          exports: format === "iife" ? "default" : "named",
        },
      },
    },
  });

  const outputPath = resolve(distDir, fileName);
  let output = await readFile(outputPath, "utf8");
  for (let pass = 0; pass < 2; pass += 1) {
    const compacted = await minifyWithTerser(output, {
      ecma: 2022,
      module: format === "es",
      compress: { passes: 3 },
      mangle: { properties: { regex: privateBrowserProperty, keep_quoted: true } },
      format: { comments: false },
    });
    if (compacted.code === undefined) throw new Error(`Could not compact ${fileName}.`);
    output = compacted.code;
  }
  await writeFile(outputPath, output);
}

function parseNumericEnums(source) {
  const enums = new Map();
  for (const match of source.matchAll(/export enum (\w+)\s*\{([^}]*)\}/gs)) {
    const values = new Map();
    let nextValue = 0;
    const members = match[2]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .split(",");
    for (const rawMember of members) {
      const [rawName, rawValue] = rawMember.split("=").map((value) => value.trim());
      if (!rawName) continue;
      if (rawValue && !/^-?\d+$/.test(rawValue)) {
        values.clear();
        break;
      }
      if (rawValue) nextValue = Number(rawValue);
      const name = rawName.replace(/^['"]|['"]$/g, "");
      values.set(name, nextValue);
      nextValue += 1;
    }
    if (values.size > 0) enums.set(match[1], values);
  }
  return enums;
}

function inlineRrwebNumericEnums() {
  return {
    name: "orange-replay-inline-rrweb-enums",
    enforce: "pre",
    transform(source, id) {
      if (!id.includes("/packages/rrweb-fork/src/") && !id.includes("/packages/sdk/src/")) return;
      const sourceFile = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true);
      const importedEnums = new Map();
      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
          continue;
        const moduleName = statement.moduleSpecifier.text;
        if (!moduleName.includes("rrweb-types") && moduleName !== "@orange-replay/rrweb-fork")
          continue;
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          const values = rrwebNumericEnums.get(importedName);
          if (values) importedEnums.set(element.name.text, values);
        }
      }
      if (importedEnums.size === 0) return;

      const locallyDeclared = new Set();
      const addBindingName = (name) => {
        if (ts.isIdentifier(name)) {
          locallyDeclared.add(name.text);
          return;
        }
        for (const element of name.elements) {
          if (ts.isBindingElement(element)) addBindingName(element.name);
        }
      };
      const collectLocalBindings = (node) => {
        if (ts.isImportDeclaration(node)) return;
        if (ts.isVariableDeclaration(node) || ts.isParameter(node)) addBindingName(node.name);
        if (
          (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isClassDeclaration(node) ||
            ts.isClassExpression(node)) &&
          node.name
        ) {
          locallyDeclared.add(node.name.text);
        }
        if (ts.isCatchClause(node) && node.variableDeclaration) {
          addBindingName(node.variableDeclaration.name);
        }
        ts.forEachChild(node, collectLocalBindings);
      };
      collectLocalBindings(sourceFile);
      for (const name of locallyDeclared) importedEnums.delete(name);
      if (importedEnums.size === 0) return;

      let changed = false;
      const result = ts.transform(sourceFile, [
        (context) => (root) => {
          const visit = (node) => {
            let enumName;
            let memberName;
            if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
              enumName = node.expression.text;
              memberName = node.name.text;
            } else if (
              ts.isElementAccessExpression(node) &&
              ts.isIdentifier(node.expression) &&
              ts.isStringLiteral(node.argumentExpression)
            ) {
              enumName = node.expression.text;
              memberName = node.argumentExpression.text;
            }
            const value =
              enumName && memberName ? importedEnums.get(enumName)?.get(memberName) : null;
            if (value !== null && value !== undefined) {
              changed = true;
              return ts.factory.createNumericLiteral(value);
            }
            return ts.visitEachChild(node, visit, context);
          };
          return ts.visitNode(root, visit);
        },
      ]);
      if (!changed) {
        result.dispose();
        return;
      }
      const output = ts.createPrinter().printFile(result.transformed[0]);
      result.dispose();
      return { code: output, map: null };
    },
  };
}
