/**
 * updateScriptMacOS — pure builder for the macOS update-apply bash script.
 *
 * Extracted from updateService.executeUpdateMacOS() so the generated script
 * (a release-critical path: exit-hang escalation, pre-swap clear-out, launch
 * verification) can be regression-tested without touching Electron. All
 * timing thresholds are parameterized for the same reason — tests compress
 * them to seconds and exercise the real generated artifact against real
 * processes (see __tests__/updateScriptMacOS.test.ts).
 */

import { MACOS_UPDATE_RELAUNCH_ARG } from './updateRelaunchSafety';

export interface MacUpdateScriptTimings {
  /** Seconds to wait for the old PID before escalating to SIGKILL. */
  exitKillAfterSeconds: number;
  /** Seconds after which a PID that survived SIGKILL aborts the update. */
  exitAbortAfterSeconds: number;
  /** Total seconds to poll for the relaunched main process. */
  verifyTimeoutSeconds: number;
  /** Second at which `open` is retried (only if the first open failed). */
  verifyRetryAtSeconds: number;
}

export const DEFAULT_MAC_UPDATE_SCRIPT_TIMINGS: MacUpdateScriptTimings = {
  exitKillAfterSeconds: 120,
  exitAbortAfterSeconds: 135,
  verifyTimeoutSeconds: 30,
  verifyRetryAtSeconds: 15,
};

export interface MacUpdateScriptParams {
  /** PID of the exiting app process the script must wait for. */
  pid: number;
  /** Absolute path of the installed .app bundle to replace. */
  appPath: string;
  /** Bundle name without .app, used in log lines. */
  appName: string;
  /** Temp dir the zip is extracted into. */
  extractDir: string;
  /** Downloaded update zip. */
  zipPath: string;
  /** Update lock file the bootstrap spins on during the swap. */
  lockFilePath: string;
  /** Where this script itself is written (self-deleted at the end). */
  scriptPath: string;
  /** cindy-update.log path. */
  logPath: string;
  /** Electron target architecture used to reject a wrong-arch hotfix bundle. */
  expectedArch: 'arm64' | 'x64';
  timings?: Partial<MacUpdateScriptTimings>;
}

/**
 * pgrep -f treats its pattern as an ERE — escape metacharacters so a bundle
 * path matches literally (the "." in ".app" would otherwise match any
 * character, and "()" in a path would break the expression).
 */
export function escapeEre(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildMacOSUpdateScript(params: MacUpdateScriptParams): string {
  const {
    pid,
    appPath,
    appName,
    extractDir,
    zipPath,
    lockFilePath,
    scriptPath,
    logPath,
    expectedArch,
  } = params;
  const t = { ...DEFAULT_MAC_UPDATE_SCRIPT_TIMINGS, ...params.timings };
  // Main binary only — used for launch verification ("did the app come up").
  const appBinEre = escapeEre(`${appPath}/Contents/MacOS/`);
  // Whole bundle — used for the pre-swap clear-out. Renderer/GPU/utility
  // helpers run from Contents/Frameworks/... Helper.app/Contents/MacOS and
  // can briefly outlive a SIGKILL'd main process; swapping under them is
  // just as fatal as swapping under the main binary.
  const appBundleEre = escapeEre(`${appPath}/`);
  const expectedMachArch = expectedArch === 'arm64' ? 'arm64' : 'x86_64';
  const rollbackAppPath = `${appPath}.cindy-update-rollback-${Date.now()}`;

  return [
    '#!/bin/bash',
    'set -u',
    `echo "[$(date)] Update script started, waiting for PID ${pid}" >> "${logPath}"`,
    `echo "[$(date)] target app=\\"${appPath}\\" appName=\\"${appName}\\"" >> "${logPath}"`,
    'cleanup_staging() {',
    `    rm -rf "${extractDir}"`,
    `    rm -f "${zipPath}"`,
    `    rm -f "${lockFilePath}"`,
    `    rm -f "${scriptPath}"`,
    '}',
    'trap cleanup_staging EXIT',
    '',
    // Poll until old PID exits — matches Windows :waitloop. The previous
    // single `sleep 1` was racing against ditto when the old process took
    // longer than a second to die.
    //
    // Bounded wait: process.exit(0) can hang in native teardown (observed
    // 2026-07-06: exit logged, PID stayed alive 32h, update never applied).
    // The JS event loop is already dead at that point so the process cannot
    // rescue itself — this script is the only place that can escalate.
    'WAITED=0',
    `while kill -0 ${pid} 2>/dev/null; do`,
    '    sleep 1',
    '    WAITED=$((WAITED+1))',
    `    if [ "$WAITED" -eq ${t.exitKillAfterSeconds} ]; then`,
    `        echo "[$(date)] PID ${pid} still alive after ${t.exitKillAfterSeconds}s — exit appears hung, sending SIGKILL" >> "${logPath}"`,
    `        kill -9 ${pid} 2>/dev/null`,
    '    fi',
    `    if [ "$WAITED" -ge ${t.exitAbortAfterSeconds} ]; then`,
    `        echo "[$(date)] FATAL: PID ${pid} survived SIGKILL — aborting update" >> "${logPath}"`,
    '        exit 1',
    '    fi',
    'done',
    `echo "[$(date)] Process ${pid} exited, waiting for filesystem to settle" >> "${logPath}"`,
    'sleep 2',
    '',
    `echo updating > "${lockFilePath}"`,
    '',
    `mkdir -p "${extractDir}"`,
    `echo "[$(date)] Extracting: ditto -x -k \\"${zipPath}\\" \\"${extractDir}\\"" >> "${logPath}"`,
    `/usr/bin/ditto -x -k "${zipPath}" "${extractDir}" >> "${logPath}" 2>&1`,
    'DITTO_EXIT=$?',
    `echo "[$(date)] ditto exit code: $DITTO_EXIT" >> "${logPath}"`,
    'if [ $DITTO_EXIT -ne 0 ]; then',
    `    echo "[$(date)] DITTO FAILED — aborting, app left intact" >> "${logPath}"`,
    '    exit 1',
    'fi',
    '',
    'shopt -s nullglob',
    `TOP_LEVEL_APPS=("${extractDir}"/*.app)`,
    'TOP_LEVEL_APP_COUNT=${#TOP_LEVEL_APPS[@]}',
    `NEW_APP="${extractDir}/${appName}.app"`,
    'if [ "$TOP_LEVEL_APP_COUNT" -ne 1 ] || [ ! -d "$NEW_APP" ]; then',
    `    echo "[$(date)] FATAL: expected exactly ${appName}.app at ZIP root (found $TOP_LEVEL_APP_COUNT app bundles)" >> "${logPath}"`,
    '    exit 1',
    'fi',
    `echo "[$(date)] new app found: $NEW_APP" >> "${logPath}"`,
    '',
    // Compare the incoming identity with the currently installed bundle before
    // the old app is moved. This rejects a Cindy/Cindy-Meka mix-up even if the
    // ZIP file name and manifest were both wrong in the same way.
    `OLD_BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "${appPath}/Contents/Info.plist" 2>>"${logPath}")`,
    'OLD_ID_EXIT=$?',
    'NEW_BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$NEW_APP/Contents/Info.plist" 2>>"' +
      logPath +
      '")',
    'NEW_ID_EXIT=$?',
    'OLD_EXECUTABLE=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "' +
      appPath +
      '/Contents/Info.plist" 2>>"' +
      logPath +
      '")',
    'OLD_EXE_EXIT=$?',
    'NEW_EXECUTABLE=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$NEW_APP/Contents/Info.plist" 2>>"' +
      logPath +
      '")',
    'NEW_EXE_EXIT=$?',
    'if [ "$OLD_ID_EXIT" -ne 0 ] || [ "$NEW_ID_EXIT" -ne 0 ] || [ -z "$OLD_BUNDLE_ID" ] || [ "$OLD_BUNDLE_ID" != "$NEW_BUNDLE_ID" ]; then',
    `    echo "[$(date)] FATAL: bundle id mismatch old=$OLD_BUNDLE_ID new=$NEW_BUNDLE_ID" >> "${logPath}"`,
    '    exit 1',
    'fi',
    'if [ "$OLD_EXE_EXIT" -ne 0 ] || [ "$NEW_EXE_EXIT" -ne 0 ] || [ -z "$NEW_EXECUTABLE" ] || [ "$OLD_EXECUTABLE" != "$NEW_EXECUTABLE" ]; then',
    `    echo "[$(date)] FATAL: bundle executable mismatch old=$OLD_EXECUTABLE new=$NEW_EXECUTABLE" >> "${logPath}"`,
    '    exit 1',
    'fi',
    'NEW_MAIN="$NEW_APP/Contents/MacOS/$NEW_EXECUTABLE"',
    'if [ ! -f "$NEW_MAIN" ] || [ ! -s "$NEW_MAIN" ]; then',
    `    echo "[$(date)] FATAL: incoming main executable missing or empty: $NEW_MAIN" >> "${logPath}"`,
    '    exit 1',
    'fi',
    'NEW_ARCHS=$(/usr/bin/lipo -archs "$NEW_MAIN" 2>>"' + logPath + '")',
    'if ! echo " $NEW_ARCHS " | grep -q " ' + expectedMachArch + ' "; then',
    `    echo "[$(date)] FATAL: incoming architecture $NEW_ARCHS does not include ${expectedMachArch}" >> "${logPath}"`,
    '    exit 1',
    'fi',
    'if ! /usr/bin/codesign --verify --deep --strict "$NEW_APP" >> "' + logPath + '" 2>&1; then',
    `    echo "[$(date)] FATAL: incoming app signature verification failed" >> "${logPath}"`,
    '    exit 1',
    'fi',
    `echo "[$(date)] incoming identity verified: bundle=$NEW_BUNDLE_ID executable=$NEW_EXECUTABLE arch=$NEW_ARCHS" >> "${logPath}"`,
    '',
    // A fresh instance may have been launched while we waited (user reopened
    // the app between old-PID exit and the swap). Replacing the bundle under
    // a live process gets it SIGTRAP'd by macOS code-signing enforcement —
    // terminate strays before touching the bundle. Anything matching here is
    // by definition running from the bundle we are about to delete. The
    // update lock was written above, so an instance launched after that is
    // still spinning in bootstrap's lock wait and is pgrep-visible; the
    // last-instant SIGKILL sweep below runs with no sleeps between it and
    // the swap, shrinking the launch race to milliseconds.
    `STRAY_PIDS=$(pgrep -f "${appBundleEre}")`,
    'if [ -n "$STRAY_PIDS" ]; then',
    `    echo "[$(date)] instance(s) launched during update ($STRAY_PIDS) — terminating before swap" >> "${logPath}"`,
    '    kill $STRAY_PIDS 2>/dev/null',
    '    for i in 1 2 3 4 5; do',
    `        pgrep -f "${appBundleEre}" >/dev/null || break`,
    '        sleep 1',
    '    done',
    'fi',
    `STRAY_PIDS=$(pgrep -f "${appBundleEre}")`,
    'if [ -n "$STRAY_PIDS" ]; then',
    `    echo "[$(date)] SIGKILL stragglers just before swap: $STRAY_PIDS" >> "${logPath}"`,
    '    kill -9 $STRAY_PIDS 2>/dev/null',
    'fi',
    '',
    `rm -rf "${rollbackAppPath}" 2>>"${logPath}"`,
    `echo "[$(date)] Moving old app to rollback slot: ${rollbackAppPath}" >> "${logPath}"`,
    `mv "${appPath}" "${rollbackAppPath}" 2>>"${logPath}"`,
    'OLD_MOVE_EXIT=$?',
    `if [ "$OLD_MOVE_EXIT" -ne 0 ] || [ ! -d "${rollbackAppPath}" ]; then`,
    `    echo "[$(date)] FATAL: could not create rollback copy; app left intact" >> "${logPath}"`,
    '    exit 1',
    'fi',
    `echo "[$(date)] Moving new app into place" >> "${logPath}"`,
    `mv "$NEW_APP" "${appPath}" 2>>"${logPath}"`,
    'MV_EXIT=$?',
    `echo "[$(date)] mv exit code: $MV_EXIT" >> "${logPath}"`,
    `if [ $MV_EXIT -ne 0 ] || [ ! -d "${appPath}" ]; then`,
    `    echo "[$(date)] new app move failed; restoring old app" >> "${logPath}"`,
    `    rm -rf "${appPath}" 2>>"${logPath}"`,
    `    if mv "${rollbackAppPath}" "${appPath}" 2>>"${logPath}"; then`,
    `        echo "[$(date)] RESTORE SUCCEEDED: recovered previous app after move failure" >> "${logPath}"`,
    '    else',
    `        echo "[$(date)] FATAL: ROLLBACK FAILED after move failure; backup remains at ${rollbackAppPath}" >> "${logPath}"`,
    '    fi',
    '    exit 1',
    'fi',
    '',
    `/usr/bin/xattr -cr "${appPath}" 2>>"${logPath}"`,
    `echo "[$(date)] xattr cleared" >> "${logPath}"`,
    '',
    `rm -f "${lockFilePath}"`,
    '',
    `echo "[$(date)] Starting app: open \\"${appPath}\\" --args \\"${MACOS_UPDATE_RELAUNCH_ARG}\\"" >> "${logPath}"`,
    `open "${appPath}" --args "${MACOS_UPDATE_RELAUNCH_ARG}" >> "${logPath}" 2>&1`,
    'OPEN_EXIT=$?',
    `echo "[$(date)] open exit code: $OPEN_EXIT" >> "${logPath}"`,
    '',
    // open(1) returns immediately; verify the new main process actually came up
    // (Gatekeeper / quarantine / signature failure would otherwise fail
    // silently, mirroring the Windows tasklist check). First launch of a
    // freshly-installed bundle goes through a Gatekeeper deep scan that can
    // take well over 3s, so poll and retry open once halfway instead of a
    // single fixed-delay check (which false-negatived).
    'VERIFIED=0',
    `for i in $(seq 1 ${t.verifyTimeoutSeconds}); do`,
    `    if pgrep -f "${appBinEre}" >/dev/null 2>&1; then`,
    '        VERIFIED=1',
    '        break',
    '    fi',
    // Retry open only if the first one actually failed — an unconditional
    // second open while the first launch is still in its Gatekeeper scan
    // could race two instances against each other.
    `    if [ "$i" -eq ${t.verifyRetryAtSeconds} ] && [ "$OPEN_EXIT" -ne 0 ]; then`,
    `        echo "[$(date)] initial open failed (exit $OPEN_EXIT), still not up after ${t.verifyRetryAtSeconds}s — retrying open" >> "${logPath}"`,
    `        open "${appPath}" --args "${MACOS_UPDATE_RELAUNCH_ARG}" >> "${logPath}" 2>&1`,
    '        OPEN_EXIT=$?',
    '    fi',
    '    sleep 1',
    'done',
    'if [ "$VERIFIED" -eq 1 ]; then',
    `    echo "[$(date)] PROCESS VERIFIED: ${appName} main process is running; window activation is a separate presentation state" >> "${logPath}"`,
    `    rm -rf "${rollbackAppPath}" 2>>"${logPath}"`,
    'else',
    `    echo "[$(date)] PROCESS START FAILED: ${appName} NOT running ${t.verifyTimeoutSeconds}s after open — likely Gatekeeper-blocked or new bundle is corrupt" >> "${logPath}"`,
    `    NEW_PIDS=$(pgrep -f "${appBundleEre}")`,
    '    if [ -n "$NEW_PIDS" ]; then kill -9 $NEW_PIDS 2>/dev/null; fi',
    `    rm -rf "${appPath}" 2>>"${logPath}"`,
    `    if mv "${rollbackAppPath}" "${appPath}" 2>>"${logPath}"; then`,
    `        echo "[$(date)] ROLLBACK SUCCEEDED: restored previous app bundle" >> "${logPath}"`,
    `        open "${appPath}" --args "${MACOS_UPDATE_RELAUNCH_ARG}" >> "${logPath}" 2>&1`,
    '    else',
    `        echo "[$(date)] FATAL: ROLLBACK FAILED; backup remains at ${rollbackAppPath}" >> "${logPath}"`,
    '    fi',
    '    exit 1',
    'fi',
    '',
    `echo "[$(date)] Cleanup done" >> "${logPath}"`,
    'exit 0',
  ].join('\n');
}
